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

| Touche | Action |
| --- | --- |
| Flèches | Navigation spatiale entre cartes, rangées et bouton Paramètres |
| OK | Ouvrir l'application |
| OK maintenu (0,5 s) ou MENU | Épingler / retirer des favoris |
| RETOUR | Revient au début de la rangée, puis à la première rangée. Ne ferme jamais le launcher. |
| HOME | Recentre sur le premier favori |

Les favoris sont enregistrés dans le `localStorage` de la WebView (`x96q.favorites.v1`).

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
  fonts/                           Instrument Serif + Inter (woff2, licence SIL OFL), embarquées hors ligne
app/src/main/res/                  Thème, icône et bannière Leanback (vectoriels)
```

## Pont JavaScript

```js
JSON.parse(AndroidBridge.getInstalledApps())
// [{ name, packageName, isTv, icon: "data:image/png;base64,…" }]   icônes PNG 96×96
AndroidBridge.launchApp("com.google.android.youtube.tv")   // true / false
AndroidBridge.openSystemSettings()
```

Le natif appelle en retour `window.Launcher.onBack()`, `onMenu()`, `onHome()`, `onResume()` et `reload()`
(ce dernier après chaque installation ou désinstallation d'application).

## Performance (Mali-G31)

- Aucun `backdrop-filter` ni `filter: blur()`.
- Seuls `transform` (`scale3d(1.07, 1.07, 1)`, `translate3d`) et `opacity` sont animés, en 120–160 ms.
- Ombre et bordure de focus (`3px solid #FFFFFF`) pré-rendues dans des pseudo-éléments : seule leur opacité change.
- Icônes calculées une fois en arrière-plan au démarrage, puis mises en cache côté natif.
- La teinte d'ambiance n'est repeinte qu'une fois la navigation arrêtée (140 ms).

## Aperçu dans un navigateur

Ouvrez `app/src/main/assets/index.html` dans Chrome : un pont factice fournit des applications de démonstration.
La touche `P` simule MENU, `Échap` simule RETOUR.

## Licences des polices

Instrument Serif et Inter sont distribuées sous SIL Open Font License 1.1.
