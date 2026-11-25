# SONICOD – App Android (v3)

Bla login, bla admin, bla statistiques. Menu l-ta7t fih 4 :

1. **Opération** → onglet « Scanne Prepration roteur » (A→I) + WhatsApp
2. **Scanner** → onglet « Gestion Roteur » (Traking / La Date)
3. **Retour Sorties** → tsawer m3a date (bande 3la kol photo) → groupe WhatsApp « Retour Sorties »
4. **Paramètres** → mode sombre, smiya, lien groupe Retour Sorties, lien serveur

---

## Étape 1 – Serveur (Google Apps Script)

1. **https://script.google.com** → **Nouveau projet**.
2. Mse7 li f `Code.gs` w 7et l-contenu dyal `backend/Code.gs`.
3. ⚙ Paramètres du projet → 3ellem « Afficher le fichier manifeste » → 7et l-contenu dyal `backend/appsscript.json` f `appsscript.json`.
4. Khtar fonction **`setup`** → **Exécuter** → 3ti les autorisations.
5. **Déployer → Nouveau déploiement → Application Web** : Exécuter en tant que **Moi**, accès **Tout le monde**.
6. Copier l-lien li kay-sali b **`/exec`**.

## Étape 2 – (Mzyan) 7et l-lien f l-app 9bel ma tbni

F `android/app/src/main/java/ma/sonicod/operations/Core.kt` bdel had s-ster :

```kotlin
const val DEFAULT_SERVER_URL = ""
```
b :
```kotlin
const val DEFAULT_SERVER_URL = "https://script.google.com/macros/s/XXXX/exec"
```
B hakka 7ta wa7ed ma ghadi y7taj y-configurer chi 7aja f telephone. (Ila ma bdeltich, l-app kat-tlab l-lien merra wa7da f awel 7el.)

## Étape 3 – Bni l-APK b GitHub

1. Repo jdid **Private** f GitHub (ahmad8oumhirr-ctrl) → uploader had l-dossier kamel (m3a `.github`).
2. **Actions** → « Build APK SONICOD » → ≈5 min → **Artifacts** → `SONICOD-Operations-APK`.
3. Installer f telephones.

---

## Scanner retours – kifach kay-khdem

- Brak **SCANNER** → camera dyal Google (ma kat7tajch permission) → kat-scanni l-code-barres.
- **Scan en continu** : ba3d kol colis, scanner kay-t7el bo7do l colis li mn ba3d.
- L-app **katlqa bo7dha l-blasa** : kat-chof f « Gestion Roteur » akhir tracking tscanna (date l-jdida), w kat-7et l-jdid f awel case khawya ta7to (b7al daba : C199, C200…). Ma khassek tkhtar la ligne la colonne.
- La Date kat-tktab bo7dha (dd/MM/yyyy).
- **Doublon** : ila tracking déjà kayn f l-feuille → bip twil + a7mar + « Déjà : case C190 ». Ma kay-tktabch. Ila bghiti tzido b zz, brak « Ajouter ».
- Kayn 7ta **saisie manuelle** (wla lecteur code-barres Bluetooth/USB).
- **Bla internet** : scan kay-tkhba f telephone w kay-tsifet mli yrje3 réseau.

> Scanner Google khaso Google Play Services (kaynin f ga3 telephones Android 3adiyin). Awel merra kay-telecharger module sghir (khas internet).

## Nouvelle opération

Ville → Colis → Date réception → Date d'envoi → Note → Statut → Photos → **ENVOYER**
- Ligne jdida ta7t akhir opération (dima ta7t ster Hsab).
- DÉLAI kay-t7seb bo7do (formule f G), HSAB = FALSE, PHOTOS f Drive w liens f colonne I.
- « ＋ Autre ville… » f liste bach tzid ville jdida.
- WhatsApp : **Partager sur WhatsApp** (photos + message) → khtar groupe → Envoyer. **Ouvrir le groupe SONICOD** kay-7el l-lien exact.

## Paramètres
- Mode **Auto / Clair / Sombre**.
- Prénom (facultatif) → kayban f colonne PHOTOS « 📷 1 · Smiya ».
- Opérations li mazal ma tsiftouch (bla internet).

## Sécurité
L-app w script kay-t3erfo b wa7ed **clé** (`APP_KEY` f `Code.gs` w f `Core.kt`). Ila bghiti tbdelha, bdelha f jouj blayes b nafs l-valeur.
