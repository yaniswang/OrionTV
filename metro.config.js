// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

// Find the project and workspace directories
// eslint-disable-next-line no-undef
const projectRoot = __dirname;

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

// When enabled, the optional code below will allow Metro to resolve
// and bundle source files with TV-specific extensions
// (e.g., *.ios.tv.tsx, *.android.tv.tsx, *.tv.tsx)
//
// Metro will still resolve source files with standard extensions
// as usual if TV-specific files are not found for a module.
//
// if (process.env?.EXPO_TV === '1') {
//   const originalSourceExts = config.resolver.sourceExts;
//   const tvSourceExts = [
//     ...originalSourceExts.map((e) => `tv.${e}`),
//     ...originalSourceExts,
//   ];
//   config.resolver.sourceExts = tvSourceExts;
// }

// This project is self-contained, so only watch files used by the app.
config.watchFolders = [projectRoot];

// Keep package resolution scoped to this project.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
