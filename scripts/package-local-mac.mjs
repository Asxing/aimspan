#!/usr/bin/env node
// Local macOS bundle for interface acceptance: the stock Electron.app renamed
// to AimSpan, the built desktop package with its production dependencies, the
// TS background core and an ad-hoc signature. It is not a release: no
// Apple identity, no notarization, no updater (ROADMAP REL-2). Display
// branding changes here never change the storage identity: productName stays
// `aimspan`, so the existing local profile keeps working.
//
//   pnpm build
//   node scripts/package-local-mac.mjs [--out <dir>] [--install]
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");
const args = process.argv.slice(2);
const install = args.includes("--install");
const outDir = resolve(root, argumentValue("--out") ?? join("apps", "desktop", "release"));
const DISPLAY_NAME = "AimSpan";
const BUNDLE_ID = "com.aimspan.desktop";


function argumentValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });
}
function plist(file, key, value) {
  // Helper bundles lack some display keys; a failed Set falls through to Add without noise.
  try { execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, file], { stdio: "pipe" }); }
  catch { run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, file]); }
}
function require(path, hint) {
  if (!existsSync(path)) throw new Error(`Missing ${path}. ${hint}`);
  return path;
}

const electronApp = require(join(desktop, "node_modules", "electron", "dist", "Electron.app"), "Install desktop dependencies first.");
for (const built of ["dist/main/index.cjs", "dist/preload/index.cjs", "dist/renderer/index.html", "dist/brand/aimspan.png", "dist/brand/trayTemplate.png"]) {
  require(join(desktop, built), "Run `pnpm --filter @aimspan/desktop build` first.");
}

const manifest = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
if (manifest.productName !== "aimspan") throw new Error("productName is the storage identity and must stay `aimspan`.");

// Finder can recreate .DS_Store while the folder is open; retry instead of failing with ENOTEMPTY.
rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
mkdirSync(outDir, { recursive: true });

// 1. Runtime application directory: dist + production dependencies only.
const stage = join(outDir, "app");
run("pnpm", ["--filter", "@aimspan/desktop", "deploy", "--prod", "--legacy", stage], { cwd: root });
// Legacy deploy records a production-only, filtered install in the workspace
// state; restore the normal development install so later pnpm runs do not try
// to purge devDependencies.
run("pnpm", ["install", "--offline", "--frozen-lockfile"], { cwd: root });
for (const entry of readdirSync(stage)) {
  if (!["dist", "node_modules", "package.json"].includes(entry)) rmSync(join(stage, entry), { recursive: true, force: true });
}
writeFileSync(join(stage, "package.json"), JSON.stringify({
  name: manifest.name, productName: manifest.productName, version: manifest.version, private: true,
  type: manifest.type, main: manifest.main, dependencies: manifest.dependencies,
}, null, 2) + "\n");

// 2. Bundle: the stock Electron.app renamed, with its helpers.
const bundle = join(outDir, `${DISPLAY_NAME}.app`);
run("ditto", [electronApp, bundle]);
const contents = join(bundle, "Contents");
renameSync(join(contents, "MacOS", "Electron"), join(contents, "MacOS", DISPLAY_NAME));
const version = manifest.version;
const buildNumber = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const mainPlist = join(contents, "Info.plist");
for (const [key, value] of [["CFBundleName", DISPLAY_NAME], ["CFBundleDisplayName", DISPLAY_NAME], ["CFBundleExecutable", DISPLAY_NAME], ["CFBundleIdentifier", BUNDLE_ID], ["CFBundleVersion", buildNumber], ["CFBundleShortVersionString", version], ["CFBundleIconFile", "aimspan.icns"]]) plist(mainPlist, key, value);
for (const helper of readdirSync(join(contents, "Frameworks")).filter((name) => name.startsWith("Electron Helper"))) {
  const renamed = helper.replace("Electron Helper", `${DISPLAY_NAME} Helper`);
  const helperDir = join(contents, "Frameworks", renamed);
  renameSync(join(contents, "Frameworks", helper), helperDir);
  const executable = renamed.replace(/\.app$/, "");
  renameSync(join(helperDir, "Contents", "MacOS", helper.replace(/\.app$/, "")), join(helperDir, "Contents", "MacOS", executable));
  const helperPlist = join(helperDir, "Contents", "Info.plist");
  for (const [key, value] of [["CFBundleName", executable], ["CFBundleDisplayName", executable], ["CFBundleExecutable", executable], ["CFBundleIdentifier", `${BUNDLE_ID}.helper`]]) plist(helperPlist, key, value);
}

// 3. Icon from the same generated brand raster; no external art.
const iconset = join(outDir, "aimspan.iconset");
mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  run("sips", ["-z", String(size), String(size), join(desktop, "dist", "brand", "aimspan.png"), "--out", join(iconset, `icon_${size}x${size}.png`)]);
  run("sips", ["-z", String(size * 2), String(size * 2), join(desktop, "dist", "brand", "aimspan.png"), "--out", join(iconset, `icon_${size}x${size}@2x.png`)]);
}
const resources = join(contents, "Resources");
run("iconutil", ["-c", "icns", iconset, "-o", join(resources, "aimspan.icns")]);
rmSync(iconset, { recursive: true, force: true });
rmSync(join(resources, "electron.icns"), { force: true });
rmSync(join(resources, "default_app.asar"), { force: true });

// 4. Application and workspace TS packages.
run("ditto", [stage, join(resources, "app")]);
rmSync(stage, { recursive: true, force: true });

// 5. Ad-hoc signature so macOS runs the renamed bundle locally.
run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
run("codesign", ["--verify", "--deep", "--strict", bundle]);

let installedAt;
if (install) {
  const target = join("/Applications", `${DISPLAY_NAME}.app`);
  const running = (() => { try { return run("pgrep", ["-f", `^/Applications/(AimSpan|Aimspan)\\.app/Contents/MacOS/`]).trim(); } catch { return ""; } })();
  if (running) throw new Error("Quit the running AimSpan app before installing over it.");
  for (const previous of [target, join("/Applications", "Aimspan.app")]) {
    if (existsSync(previous) && statSync(previous).isDirectory()) rmSync(previous, { recursive: true, force: true });
  }
  run("ditto", [bundle, target]);
  installedAt = target;
}
process.stdout.write(JSON.stringify({ bundle, installedAt: installedAt ?? null, electron: readFileSync(join(desktop, "node_modules", "electron", "package.json"), "utf8").match(/"version":\s*"([^"]+)"/)?.[1] ?? "unknown", version, build: buildNumber, signature: "adhoc", core: "typescript" }) + "\n");
