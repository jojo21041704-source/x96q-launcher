# X96Q Launcher

Launcher Android TV 10-foot pour le boîtier **X96Q** (Allwinner H313, Android 10).
Coque native Kotlin minimale + interface HTML/CSS/JS dans une WebView plein écran.
L'APK est compilé automatiquement par **GitHub Actions** : Android Studio n'est pas nécessaire.

## Récupérer l'APK

1. Créez un dépôt GitHub vide, puis poussez ce dossier sur la branche `main` (voir plus bas).
2. Onglet **Actions** → workflow **Build APK** → dernière exécution.
3. En bas de la page, section **Artifacts** : téléchargez `X96Q-Launcher-APK` (un zip contenant `app-debug.apk`).

Le workflow peut aussi être relancé à la main : **Actions → Build APK → Run workflow**.

## Pousser le projet

```bash
git init -b main
git add .
git commit -m "X96Q Launcher"
git remote add origin https://github.com/<vous>/x96q-launcher.git
git push -u origin main
```

> Le fichier `.gitattributes` force des fins de ligne LF pour `gradlew`, même depuis Windows.
> Sans cela, le build échoue avec `/usr/bin/env: 'sh\r': No such file or directory`.

## Installer sur le X96Q

```bash
adb connect <ip-du-boitier>:5555
adb install -r app-debug.apk
```

Ou copiez l'APK sur une clé USB et installez-le avec un gestionnaire de fichiers.
Appuyez ensuite sur **HOME** : Android propose de choisir le launcher. Sélectionnez **X96Q Launcher → Toujours**.

## Télécommande

Toutes les touches sont interceptées nativement (`MainActivity.dispatchKeyEvent`) puis relayées à
`window.onRemoteKey(nom, repeat)` : la WebView ne reçoit jamais les flèches et ne peut pas bloquer le focus.

| Touche | Action |
| --- | --- |
| Flèches | Paramètres ↕ Favoris ↕ Toutes les applications ; Gauche/Droite avec défilement centré |
| OK | Ouvrir l'application (ou les Paramètres) |
| OK maintenu (0,55 s) ou MENU | Épingler / retirer des favoris |
| RETOUR | Toutes les apps → Favoris → première tuile. Ne ferme jamais le launcher. |
| HOME | Revient à la première tuile des Favoris |

Le dock n'est jamais vide : au premier démarrage il est rempli avec 5 applications
(Nuvio, YouTube, SmartTube, Netflix, Stremio… si présentes), sauvegardées dans `localStorage` (`x96q.dock.v2`).

## Arborescence

```
.github/workflows/build.yml        CI : Java 17 → ./gradlew assembleDebug → artifact
gradle/wrapper/                    Gradle Wrapper 8.11.1 (jar inclus)
gradlew, gradlew.bat
settings.gradle.kts, build.gradle.kts, gradle.properties
app/build.gradle.kts               AGP 8.7.3, Kotlin 1.9.24, minSdk 21, targetSdk 34, aucune dépendance
app/src/main/AndroidManifest.xml   HOME + LEANBACK_LAUNCHER, paysage, plein écran
app/src/main/java/com/x96q/launcher/
  MainActivity.kt                  WebView plein écran, interception RETOUR/MENU, écoute install/désinstall
  AndroidBridge.kt                 getInstalledApps() / launchApp() / openSystemSettings()
app/src/main/assets/
  index.html, style.css, app.js    Interface 10-foot (canevas 1920×1080)
  fonts/                           Inter 400–800 (woff2, licence SIL OFL), embarquée hors ligne
app/src/main/res/                  Thème, icône et bannière Leanback (vectoriels)
```

## Météo

La barre du haut affiche la température actuelle à Témara / Rabat
(`api.open-meteo.com`, sans clé API). La réponse est gardée 30 min dans `localStorage` :
au plus une requête par demi-heure, et la dernière valeur connue reste affichée hors connexion.
Pour changer de ville, modifiez `latitude` / `longitude` dans `WEATHER_URL` (`app.js`).

## Pont JavaScript

```js
JSON.parse(AndroidBridge.getInstalledApps())
// [{ name, packageName, isTv, category, accentColor: "#RRGGBB", icon: "data:image/png;base64,…" }]  icônes 128×128
AndroidBridge.getAppBanner("com.netflix.ninja")            // bannière Android TV 480×270 ou ""
AndroidBridge.launchApp("com.google.android.youtube.tv")   // true / false
AndroidBridge.openSystemSettings()
```

Le natif appelle `window.onRemoteKey(nom, repeat)` pour chaque touche, et `window.Launcher.onHome()`, `onResume()`, `reload()`
(ce dernier après chaque installation ou désinstallation d'application).

## Performance (Mali-G31)

**Démarrage à froid**
- Fenêtre et WebView peintes en `#050608` dès la première frame : ni flash blanc, ni trou.
- `app.js` affiche immédiatement la dernière liste connue (`localStorage › cached_apps_v1` : noms, couleurs, icônes).
- Le scan `PackageManager` tourne sur un thread d'arrière-plan lancé avant même la création de la WebView.
  Les icônes déjà converties sont relues depuis `cacheDir/icons` : seule une app nouvelle ou mise à jour est reconvertie.
- Le natif n'appelle `window.onAppsUpdated({sig, apps})` que si la signature (paquets + dates de mise à jour) diffère.
- Page rechargée au retour si elle est vide ; WebView recréée si son processus de rendu est tué faute de mémoire.

**Navigation à 60 FPS**
- Focus et glissement en 105 ms, `cubic-bezier(0.16, 1, 0.3, 1)`, uniquement `transform` / `opacity`.
- Aucune ombre floue sur les tuiles : seule la bordure blanche nette de 3,5 px.
- Halo d'ambiance : deux `<canvas>` 320×180 étirés par le GPU ; un changement de couleur redessine
  58 000 pixels hors écran (au lieu de 2 millions), après 110 ms d'immobilité, puis fondu d'opacité de 140 ms.
- Déplacement du rail par simple calcul (index × pas) : aucune mesure DOM, aucun `localStorage` pendant la navigation.
- CSS compatible avec les anciennes WebView d'Android 10 : ni `inset`, ni `gap` en flexbox.

**Horloge**
- Vérifiée chaque seconde ; si l'horloge du boîtier a plus de 90 s d'écart avec l'en-tête HTTP `Date`
  d'Open-Meteo (lu côté natif), l'affichage est corrigé automatiquement.

## Aperçu dans un navigateur

Ouvrez `app/src/main/assets/index.html` dans Chrome : un pont factice fournit des applications de démonstration.
La touche `M` simule MENU, `Échap` simule RETOUR, `Entrée` maintenue épingle.

## Licences des polices

Inter est distribuée sous SIL Open Font License 1.1.
