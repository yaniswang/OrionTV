const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const source = path.join(projectRoot, "xml", "AndroidManifest.xml");
const target = path.join(projectRoot, "android", "app", "src", "main", "AndroidManifest.xml");

fs.copyFileSync(source, target);
console.log("Copied AndroidManifest.xml to android/app/src/main/AndroidManifest.xml");
