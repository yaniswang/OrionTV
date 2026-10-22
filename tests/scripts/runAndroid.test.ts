import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  acquireLock,
  releaseLock,
  getDeviceArgName,
  getSelectableDevices,
  hasDeviceArg,
  resolveDeviceSelectionArgs,
  resolveDeviceSerial,
} = require("../../scripts/run-android.js");

// 不存在的 PID，用来模拟被强杀后遗留的锁
const DEAD_PID = 999999;

describe("run-android 单实例锁", () => {
  let lockPath: string;

  beforeEach(() => {
    lockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "run-android-")), "run-android.lock");
  });

  it("没有锁时获取成功，并写入当前进程 PID", () => {
    expect(acquireLock(lockPath)).toEqual({ ok: true });
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("已有存活的 yarn android 时拒绝，并返回它的 PID", () => {
    fs.writeFileSync(lockPath, String(process.ppid));

    expect(acquireLock(lockPath)).toEqual({ ok: false, pid: process.ppid });
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.ppid));
  });

  it("锁里的进程已不存在（被强杀）时视为失效，获取成功", () => {
    fs.writeFileSync(lockPath, String(DEAD_PID));

    expect(acquireLock(lockPath)).toEqual({ ok: true });
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("只释放自己持有的锁", () => {
    fs.writeFileSync(lockPath, String(process.ppid));
    releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);

    fs.writeFileSync(lockPath, String(process.pid));
    releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe("run-android 设备选择", () => {
  type Device = {
    name: string;
    isAuthorized: boolean;
    isBooted: boolean;
    pid?: string;
    type?: string;
    connectionType?: string;
  };
  const device = (name: string, isBooted: boolean, isAuthorized = true): Device => ({
    name,
    isBooted,
    isAuthorized,
  });
  const loadDevices = (devices: Device[]) => async () => devices;

  it("已连接设备和未启动模拟器都参与选择", async () => {
    const promptForDevice = jest.fn().mockResolvedValue(device("Television_1080p", false));

    await expect(
      resolveDeviceSelectionArgs(
        [],
        loadDevices([device("emulator-5556", true), device("Television_1080p", false)]),
        promptForDevice
      )
    ).resolves.toEqual(["--device", "Television_1080p"]);
    expect(promptForDevice).toHaveBeenCalledWith([
      device("emulator-5556（已启动）", true),
      device("Television_1080p", false),
    ]);
  });

  it("有多个已连接设备时让用户选择", async () => {
    const promptForDevice = jest.fn().mockResolvedValue(device("tv-box（已启动）", true));

    await expect(
      resolveDeviceSelectionArgs(
        [],
        loadDevices([device("emulator-5556", true), device("tv-box", true), device("Television_1080p", false)]),
        promptForDevice
      )
    ).resolves.toEqual(["--device", "tv-box"]);
    expect(promptForDevice).toHaveBeenCalledWith([
      device("emulator-5556（已启动）", true),
      device("tv-box（已启动）", true),
      device("Television_1080p", false),
    ]);
  });

  it("排除 PID 与真实 ADB 序列号不一致的网络设备", async () => {
    const staleNetworkDevice: Device = {
      name: "2106118C",
      pid: "adb-5cb6b8cb-JKFOWf",
      type: "device",
      connectionType: "Network",
      isBooted: true,
      isAuthorized: true,
    };
    const tvDevice: Device = {
      name: "Television_1080p",
      pid: "emulator-5554",
      type: "emulator",
      isBooted: true,
      isAuthorized: true,
    };
    const promptForDevice = jest.fn().mockResolvedValue(tvDevice);

    await expect(
      resolveDeviceSelectionArgs(
        [],
        loadDevices([staleNetworkDevice, tvDevice]),
        promptForDevice,
        {
          loadAdbSerials: async () =>
            new Set([
              "adb-5cb6b8cb-JKFOWf (2)._adb-tls-connect._tcp",
              "emulator-5554",
            ]),
        }
      )
    ).resolves.toEqual(["--device", "Television_1080p"]);
    expect(promptForDevice).not.toHaveBeenCalled();
  });

  it("没有已连接设备时直接启动唯一的模拟器", async () => {
    const promptForDevice = jest.fn();

    await expect(
      resolveDeviceSelectionArgs(
        [],
        loadDevices([device("Television_1080p", false)]),
        promptForDevice
      )
    ).resolves.toEqual(["--device", "Television_1080p"]);
    expect(promptForDevice).not.toHaveBeenCalled();
  });

  it("没有已连接设备且有多个模拟器时让用户选择要启动的模拟器", async () => {
    const promptForDevice = jest.fn().mockResolvedValue(device("Television_1080p", false));

    await expect(
      resolveDeviceSelectionArgs(
        [],
        loadDevices([device("Medium_Phone_API_37.0", false), device("Television_1080p", false)]),
        promptForDevice
      )
    ).resolves.toEqual(["--device", "Television_1080p"]);
    expect(promptForDevice).toHaveBeenCalled();
  });

  it("未授权设备不参与选择", async () => {
    await expect(
      resolveDeviceSelectionArgs(
        [],
        loadDevices([device("unauthorized", true, false), device("emulator-5556", true)]),
        jest.fn()
      )
    ).resolves.toEqual(["--device", "emulator-5556"]);
  });

  it.each([["-d"], ["--device"], ["--device=emulator-5554"], ["-d=emulator-5554"]])(
    "已经指定设备参数 %s 时直接使用该参数",
    async (deviceArg) => {
      const loadDevicesMock = jest.fn();

      await expect(
        resolveDeviceSelectionArgs([deviceArg], loadDevicesMock, jest.fn())
      ).resolves.toEqual([]);
      expect(loadDevicesMock).not.toHaveBeenCalled();
    }
  );

  it("设备检测失败时保留 Expo 默认行为", async () => {
    await expect(
      resolveDeviceSelectionArgs([], async () => {
        throw new Error("adb failed");
      })
    ).resolves.toEqual([]);
  });

  it("所有已授权设备都可选，不受启动状态影响", () => {
    expect(
      getSelectableDevices([device("emulator-5556", true), device("Television_1080p", false)])
    ).toEqual([device("emulator-5556", true), device("Television_1080p", false)]);
  });

  it("识别设备参数", () => {
    expect(hasDeviceArg(["--variant", "debug", "--device"])).toBe(true);
    expect(hasDeviceArg(["--variant", "debug"])).toBe(false);
  });

  it("提取 --device 参数中的设备名称", () => {
    expect(getDeviceArgName(["--device", "Television_1080p"])).toBe(
      "Television_1080p"
    );
    expect(getDeviceArgName(["--device=emulator-5554"])).toBe("emulator-5554");
    expect(getDeviceArgName(["-d=emulator-5554"])).toBe("emulator-5554");
    expect(getDeviceArgName([])).toBeNull();
  });

  it("为已选 TV 模拟器解析出真实 ADB 序列号", async () => {
    const tvDevice = {
      name: "Television_1080p",
      pid: "emulator-5554",
      type: "emulator",
      isBooted: true,
      isAuthorized: true,
    };

    await expect(
      resolveDeviceSerial(
        ["--device", "Television_1080p"],
        async () => [tvDevice],
        () => new Set(["emulator-5554"])
      )
    ).resolves.toBe("emulator-5554");
  });
});

describe("run-android adb 卡死恢复", () => {
  const device = (name: string) => ({ name, isBooted: true, isAuthorized: true });
  const never = () => new Promise<never>(() => {});

  it("设备检测超时后重启 adb 并重试成功", async () => {
    const restartAdb = jest.fn();
    const log = { warn: jest.fn() };
    let calls = 0;
    const loadDevices = () => {
      calls += 1;
      return calls === 1 ? never() : Promise.resolve([device("emulator-5554")]);
    };

    await expect(
      resolveDeviceSelectionArgs([], loadDevices, jest.fn(), {
        scanTimeoutMs: 20,
        restartAdb,
        log,
      })
    ).resolves.toEqual(["--device", "emulator-5554"]);
    expect(restartAdb).toHaveBeenCalledTimes(1);
  });

  it("重试仍超时则回退为 Expo 自动选择并提示", async () => {
    const restartAdb = jest.fn();
    const log = { warn: jest.fn() };
    const loadDevices = jest.fn(() => never());

    await expect(
      resolveDeviceSelectionArgs([], loadDevices, jest.fn(), {
        scanTimeoutMs: 20,
        restartAdb,
        log,
      })
    ).resolves.toEqual([]);
    expect(restartAdb).toHaveBeenCalledTimes(1);
    expect(loadDevices).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalled();
  });
});
