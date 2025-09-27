# CardCue — 1.1.6 Alpha 
CardCue is a zero-build flashcards + MCQ micro-app.  
It runs entirely in the browser, installs as a Progressive Web App (PWA), and works offline.

---

## Use it
- **Study**: open `study.html` to learn and test yourself.
- **Metrics**: open `metrics.html` to review progress and topic-level statistics.
- **Editor**: open `editor.html` to add or update cards.

All pages share the same deck data via local storage.

---

## Branding
Update `config.js` to customise the app name, colours, and icon path:

```js
window.APP = {
  name: "CardCue",
  shortName: "CardCue",
  themeColor: "#8b93ff",      // PWA tint colour
  backgroundColor: "#0b0e14", // Splash background colour
  iconsPath: "icons"          // Directory for icons
};
