module.exports = ({ config }) => {
  // Hosted Metro previews run without an Expo account on the computer.
  // Keep them anonymous so Expo Go does not require the EAS owner's login.
  // Builds and EAS updates keep the project settings from app.json.
  if (!process.env.EXPO_PACKAGER_PROXY_URL) return config;

  const preview = { ...config, extra: { ...config.extra } };
  delete preview.owner;
  delete preview.extra.eas;
  delete preview.updates;
  return preview;
};
