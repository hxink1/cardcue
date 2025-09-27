/**
 * Global application configuration for CardCue.
 * Exposes a single object on `window.APP` used for branding and PWA metadata.
 *
 * Properties:
 * - name {string} - Full brand name used across the UI and document title.
 * - shortName {string} - Shorter name used where space is limited, including badges.
 * - themeColor {string} - Primary theme colour used for the PWA tint and browser UI.
 * - backgroundColor {string} - Splash screen and background colour for the PWA.
 * - iconsPath {string} - Relative path to the icons directory.
 * - version: {string} - its the variable in version.js that I can change when I do any update
 * - last updated {date} - YYYY-MM-DD, bump on deploy
 */
window.APP = {
  name: 'CardCue',
  shortName: 'CardCue',
  themeColor: '#8b93ff',
  backgroundColor: '#0b0e14',
  iconsPath: 'icons',
  version: self.APP_VERSION,
  lastUpdated: self.APP_LAST_UPDATED
};