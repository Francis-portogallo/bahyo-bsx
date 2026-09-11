# Guide de déploiement O2 — Bahyo BSX

## Chaîne de déploiement

```
┌─────────┐    git push     ┌──────────┐   webhook   ┌─────────────┐  .cpanel.yml  ┌──────────────┐
│   Mac   │ ───────────────▶│  GitHub  │────────────▶│ cPanel Git™ │──────────────▶│ ~/bsx/ (prod) │
└─────────┘                  └──────────┘             └─────────────┘                └──────────────┘
   éditer                     stockage                 clone + pull                    Passenger
   commit                     versionné                sur O2                          restart auto
```

## 1. Setup initial (une seule fois)

### 1.1 Récupérer l'état actuel de production

```bash
cd ~/bahyo-bsx
chmod +x sync-from-o2.sh
./sync-from-o2.sh
```

Cela télécharge tous les fichiers depuis O2 dans votre repo local.

### 1.2 Renommer le template

```bash
mv package.json.example package.json
```

Ajustez les versions si nécessaire (`npm audit` a mis à jour bcrypt, uuid, adm-zip).

### 1.3 Initialiser git

```bash
git init
git add .
git commit -m "Initial: v3.0.0 refonte 3 onglets"
git branch -M main
```

### 1.4 Créer le repo GitHub

- github.com → **New repository** → **bahyo-bsx** → **Private** → **Create**
- Ne pas ajouter README/gitignore/licence (ils existent déjà)

### 1.5 Personal Access Token GitHub

- github.com → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → **Generate new token**
- **Repository access** : Only select repositories → `bahyo-bsx`
- **Permissions** : Contents = **Read and write**
- Copier le token (ghp_XXX...) — visible une seule fois

### 1.6 Push initial

```bash
git remote add origin https://github.com/VOTRE_USER/bahyo-bsx.git
git push -u origin main
```

Authentification : user = votre nom GitHub, mot de passe = le token PAT.

### 1.7 cPanel Git™ Version Control

- cPanel → **Git™ Version Control** → **Create**
- **Clone URL** : `https://VOTRE_USER:ghp_TOKEN@github.com/VOTRE_USER/bahyo-bsx.git`
- **Repository Path** : `/home2/qiyo9734/bahyo-bsx-git`
- **Repository Name** : `bahyo-bsx`
- **Create**

### 1.8 Premier déploiement manuel

- cPanel Git™ → onglet **Pull or Deploy**
- **Update from Remote** (récupère le dernier commit)
- **Deploy HEAD Commit** (exécute .cpanel.yml)

Vérifier :
```bash
curl -s https://bsx.bahyo.net/health
cat ~/bsx/.deploy-date
```

## 2. Workflow quotidien

### Édition + push

```bash
cd ~/bahyo-bsx
# modifier src/routes/auth.js par exemple
git add src/routes/auth.js
git commit -m "auth.js v1.8.1: fix XYZ"
git push
```

### Déployer sur O2

**Option A (manuel, 2 clics)** : cPanel Git™ → Update from Remote + Deploy HEAD

**Option B (automatique)** : webhook GitHub → cPanel

## 3. Webhook auto-deploy (option B)

### 3.1 Récupérer l'URL de déploiement

- cPanel Git™ Version Control → cliquer sur le repo `bahyo-bsx`
- Onglet **Pull or Deploy** → bouton **How to Deploy** → l'URL est affichée

### 3.2 Ajouter le webhook GitHub

- GitHub → repo `bahyo-bsx` → **Settings** → **Webhooks** → **Add webhook**
- **Payload URL** : l'URL cPanel
- **Content type** : `application/json`
- **Secret** : (optionnel, à définir aussi côté cPanel)
- **Which events** : Just the push event
- **Active** : coché
- **Add webhook**

À partir de maintenant, chaque `git push` déclenche automatiquement le déploiement.

## 4. Migrations SQL (hors git)

Les migrations sont dans le repo pour référence, mais **non exécutées automatiquement**. Elles doivent être passées manuellement dans phpPgAdmin :

1. Se connecter à phpPgAdmin
2. Sélectionner `qiyo9734_bahyo`
3. Onglet SQL → **décocher "Paginer les résultats"**
4. Coller le contenu de la migration
5. Exécuter

Ordre à respecter : 000 → 001 → ... → 014.

## 5. Rollback en cas de problème

### Git : revenir à un commit antérieur

```bash
cd ~/bahyo-bsx
git log --oneline           # voir l'historique
git revert HEAD             # annuler le dernier commit
git push
```

Puis re-déployer via cPanel.

### O2 : redémarrer manuellement

Si le déploiement a cassé quelque chose :
- cPanel → Setup Node.js App → bsx → **Restart App**
- Ou en shell : `touch ~/bsx/tmp/restart.txt`

## 6. Fichiers à NE JAMAIS commiter

Listés dans `.gitignore` :
- `.env` (secrets DB, JWT, SMTP, Anthropic)
- `node_modules/`
- `public/.htaccess` (généré par cPanel)
- `.cagefs/`
- Uploads utilisateurs, backups

## 7. Dépannage

**"Permission denied (publickey)"** au sync : configurer une clé SSH pour votre user O2 (cPanel → SSH Access).

**"Deploy failed"** : vérifier les logs cPanel Git™ (visible dans l'onglet History).

**Passenger ne redémarre pas** : le fichier `~/bsx/tmp/restart.txt` doit être créé ; sinon utiliser cPanel Restart manuellement.
