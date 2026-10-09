import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { acquireLock, releaseLock } = require("../../scripts/run-android.js");

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
