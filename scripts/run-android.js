#!/usr/bin/env node
/* eslint-env node */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { resolveEntryPoint } = require("@expo/config/paths");
const { getDevicesAsync } = require("@expo/cli/build/src/start/platforms/android/getDevices");
const { promptForDeviceAsync } = require("@expo/cli/build/src/start/platforms/android/promptAndroidDevice");

const projectRoot = path.resolve(__dirname, "..");
const expoCli = path.join(projectRoot, "node_modules", "expo", "bin", "cli");
// 记录正在运行的 yarn android 的 PID，保证同时只有一个
const LOCK_PATH = path.join(projectRoot, ".expo", "run-android.lock");
const originalRunArgs = process.argv.slice(2);
const { port, args: runArgs } = extractPort(originalRunArgs);
const baseEnv = {
  ...process.env,
  EXPO_TV: "1",
  EXPO_USE_METRO_WORKSPACE_ROOT: "1",
};

let metroProcess = null;
let runProcess = null;
let stopping = false;

function extractPort(args) {
  let port = 8081;
  const remaining = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--port" || arg === "-p") {
      port = Number(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
      continue;
    }

    if (arg !== "--no-bundler") {
      remaining.push(arg);
    }
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid Metro port: ${port}`);
  }

  return { port, args: remaining };
}

function hasDeviceArg(args) {
  return args.some(
    (arg) => arg === "-d" || arg === "--device" || arg.startsWith("--device=") || arg.startsWith("-d=")
  );
}

function getDeviceArgName(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-d" || arg === "--device") {
      return args[index + 1] || null;
    }
    if (arg.startsWith("--device=")) {
      return arg.slice("--device=".length);
    }
    if (arg.startsWith("-d=")) {
      return arg.slice("-d=".length);
    }
  }
  return null;
}

function getSelectableDevices(devices, adbSerials = null) {
  return devices.filter((device) => {
    if (!device.isAuthorized) return false;
    if (!adbSerials || !device.isBooted || !device.pid) return true;
    return adbSerials.has(device.pid);
  });
}

const BOOTED_DEVICE_LABEL = "（已启动）";
const DEVICE_SCAN_TIMEOUT_MS = 15000;

function addBootedDeviceLabel(device) {
  return device.isBooted ? { ...device, name: `${device.name}${BOOTED_DEVICE_LABEL}` } : device;
}

function removeBootedDeviceLabel(name) {
  return name.endsWith(BOOTED_DEVICE_LABEL)
    ? name.slice(0, -BOOTED_DEVICE_LABEL.length)
    : name;
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function resolveAdbPath() {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdkRoot) {
    const candidate = path.join(
      sdkRoot,
      "platform-tools",
      process.platform === "win32" ? "adb.exe" : "adb"
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return "adb";
}

function readAdbDeviceSerials() {
  const result = spawnSync(resolveAdbPath(), ["devices"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const serials = new Set();
  String(result.stdout || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const match = line.match(/^(.+?)\s+device(?:\s|$)/);
      if (match) serials.add(match[1].trim());
    });
  return serials;
}

async function resolveDeviceSerial(
  args,
  loadDevices = getDevicesAsync,
  loadAdbSerials = readAdbDeviceSerials
) {
  const name = getDeviceArgName(args);
  if (!name) return null;
  const devices = await loadDevices();
  const device = devices.find((candidate) => candidate.name === name);
  if (!device?.isBooted) return null;
  const adbSerials = loadAdbSerials();
  if (device.pid && (!adbSerials || adbSerials.has(device.pid))) {
    return device.pid;
  }
  if (!adbSerials || !device.pid) return null;
  return (
    [...adbSerials].find(
      (serial) => serial === device.name || serial.startsWith(`${device.pid} `)
    ) || null
  );
}

function configureDeviceReverse(serial, targetPort) {
  if (!serial) return false;
  const result = spawnSync(
    resolveAdbPath(),
    ["-s", serial, "reverse", `tcp:${targetPort}`, `tcp:${targetPort}`],
    {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    }
  );
  return result.status === 0;
}

/** adb server 卡死时 kill-server 也会一起挂住，Windows 下直接结束 adb 进程再拉起 */
function restartAdbServer() {
  const adb = resolveAdbPath();
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/IM", "adb.exe", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    spawnSync(adb, ["kill-server"], { stdio: "ignore", timeout: 5000 });
  }
  spawnSync(adb, ["start-server"], {
    stdio: "ignore",
    timeout: 15000,
    windowsHide: true,
  });
}

async function scanDevices(loadDevices, timeoutMs, restartAdb, log) {
  try {
    return await withTimeout(loadDevices(), timeoutMs, "device scan timeout");
  } catch (error) {
    if (error.message !== "device scan timeout") throw error;
    log.warn("[android] adb 设备检测超时，正在重启 adb server...");
    restartAdb();
    return withTimeout(loadDevices(), timeoutMs, "device scan timeout");
  }
}

async function resolveDeviceSelectionArgs(
  args,
  loadDevices = getDevicesAsync,
  promptForDevice = promptForDeviceAsync,
  options = {}
) {
  if (hasDeviceArg(args)) {
    return [];
  }

  const {
    scanTimeoutMs = DEVICE_SCAN_TIMEOUT_MS,
    restartAdb = restartAdbServer,
    loadAdbSerials = readAdbDeviceSerials,
    log = console,
  } = options;

  let devices;
  try {
    devices = await scanDevices(loadDevices, scanTimeoutMs, restartAdb, log);
  } catch (error) {
    log.warn(`[android] 无法获取设备列表：${error.message}`);
    log.warn("[android] 可手动执行 adb kill-server 后重试，或使用 --device <名称> 指定设备。");
    return [];
  }

  let adbSerials = null;
  if (devices.some((device) => device.isBooted && device.pid)) {
    try {
      adbSerials = await loadAdbSerials();
    } catch {
      adbSerials = null;
    }
  }
  const candidates = getSelectableDevices(devices, adbSerials);
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return ["--device", candidates[0].name];

  const device = await promptForDevice(candidates.map(addBootedDeviceLabel));
  return ["--device", removeBootedDeviceLabel(device.name)];
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但无权发信号
    return error.code === "EPERM";
  }
}

/** 获取单实例锁；已有存活的 yarn android 时返回它的 PID，锁里的进程已退出（如被强杀）则接管 */
function acquireLock(lockPath = LOCK_PATH) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return { ok: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
    return { ok: false, pid };
  }

  fs.writeFileSync(lockPath, String(process.pid));
  return { ok: true };
}

function releaseLock(lockPath = LOCK_PATH) {
  try {
    if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // 锁文件不存在或已被删除
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestStatus(host) {
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: host, port, path: "/status", timeout: 1000 },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode === 200));
      }
    );

    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function probeMetro() {
  for (const host of ["127.0.0.1", "::1"]) {
    if (await requestStatus(host)) {
      return host;
    }
  }
  return null;
}

async function waitForMetro(timeoutMilliseconds = 120000) {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    if (metroProcess && metroProcess.exitCode != null) {
      throw new Error(`Metro exited before it became ready (code ${metroProcess.exitCode}).`);
    }

    const host = await probeMetro();
    if (host) {
      return host;
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for Metro on port ${port}.`);
}

function startMetro() {
  console.log(`[android] Starting Metro on port ${port}...`);
  metroProcess = spawn(
    process.execPath,
    [expoCli, "start", "--port", String(port)],
    {
      cwd: projectRoot,
      env: baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  metroProcess.stdout.on("data", (data) => process.stdout.write(data));
  metroProcess.stderr.on("data", (data) => process.stderr.write(data));
}

function buildBundleUrl(host) {
  const entryPoint = resolveEntryPoint(projectRoot, { platform: "android" });
  const relativeEntry = path
    .relative(projectRoot, entryPoint)
    .replace(/\.[^/.]+$/, "")
    .replace(/[\\/]/g, "\\");
  const query = new URLSearchParams({
    platform: "android",
    dev: "true",
    hot: "false",
    lazy: "true",
    "transform.engine": "hermes",
    "transform.bytecode": "true",
    "transform.routerRoot": "app",
  });

  return `http://${host}:${port}/${encodeURIComponent(relativeEntry)}.bundle?${query}`;
}

function prewarmBundle(host) {
  const url = buildBundleUrl(host);
  console.log("[android] Prebuilding the Android bundle in parallel with Gradle...");

  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 180000 }, (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode === 200) {
          console.log("[android] Android bundle is ready.");
          resolve();
          return;
        }

        reject(new Error(`Bundle prewarm failed with HTTP ${response.statusCode}.`));
      });
    });

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("Timed out while prebuilding the Android bundle."));
    });
  });
}

function runExpo(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [expoCli, ...args], {
      cwd: projectRoot,
      env: baseEnv,
      stdio: "inherit",
    });
    runProcess = child;

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (runProcess === child) {
        runProcess = null;
      }
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Expo exited with ${signal || `code ${code}`}.`));
    });
  });
}

/** Ctrl+C 时连 expo run:android 及其 Gradle/adb 子进程一起结束，避免留下半死的 adb 调用 */
function stopRunProcess() {
  const child = runProcess;
  if (!child || child.exitCode != null || !child.pid) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  child.kill("SIGINT");
}

function waitForProcess(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}

function stopMetro() {
  if (stopping || !metroProcess || metroProcess.exitCode != null) {
    return;
  }

  stopping = true;

  const processId = metroProcess.pid;
  metroProcess.kill("SIGINT");

  if (process.platform === "win32" && processId) {
    spawnSync("taskkill", ["/pid", String(processId), "/T", "/F"], {
      stdio: "ignore",
    });
  } else if (metroProcess.exitCode == null) {
    metroProcess.kill("SIGKILL");
  }
}

async function main() {
  const lock = acquireLock();
  if (!lock.ok) {
    throw new Error(`Another "yarn android" is already running (PID ${lock.pid}). Stop it first.`);
  }
  process.on("exit", () => releaseLock());
  const deviceArgs = await resolveDeviceSelectionArgs(runArgs);

  if (port !== 8081) {
    await runExpo(["run:android", ...deviceArgs, ...originalRunArgs]);
    return;
  }

  // 不复用已有的 Metro：复用时 Expo 退出会删掉 adb reverse，App 连不上 Metro
  if (await probeMetro()) {
    throw new Error(`Port ${port} is already used by another Metro. Stop it first.`);
  }

  startMetro();
  const metroHost = await waitForMetro();
  const selectedSerial = await resolveDeviceSerial(deviceArgs).catch(() => null);
  if (configureDeviceReverse(selectedSerial, port)) {
    console.log(`[android] ADB reverse configured on ${selectedSerial}.`);
  } else if (selectedSerial) {
    console.warn(`[android] Failed to configure ADB reverse on ${selectedSerial}.`);
  }

  let prewarmError = null;
  const prewarm = prewarmBundle(metroHost).catch((error) => {
    prewarmError = error;
  });

  try {
    await runExpo(["run:android", "--no-bundler", ...deviceArgs, ...runArgs]);
    const activeSerial = await resolveDeviceSerial(deviceArgs).catch(() => null);
    if (activeSerial && !configureDeviceReverse(activeSerial, port)) {
      console.warn(`[android] Failed to configure ADB reverse on ${activeSerial}.`);
    }
  } catch (error) {
    stopRunProcess();
    stopMetro();
    throw error;
  }

  await prewarm;

  if (prewarmError) {
    stopMetro();
    throw prewarmError;
  }

  console.log("[android] Metro remains running for Fast Refresh. Press Ctrl+C to stop.");
  await waitForProcess(metroProcess);
}

process.on("SIGINT", () => {
  stopRunProcess();
  stopMetro();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopRunProcess();
  stopMetro();
  process.exit(143);
});

module.exports = {
  acquireLock,
  releaseLock,
  buildBundleUrl,
  extractPort,
  getDeviceArgName,
  getSelectableDevices,
  hasDeviceArg,
  prewarmBundle,
  probeMetro,
  readAdbDeviceSerials,
  resolveDeviceSerial,
  restartAdbServer,
  resolveDeviceSelectionArgs,
  scanDevices,
  startMetro,
  stopRunProcess,
  stopMetro,
  waitForMetro,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[android] ${error.message}`);
    stopRunProcess();
    stopMetro();
    process.exitCode = 1;
  });
}

