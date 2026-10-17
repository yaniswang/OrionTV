import * as FileSystem from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import ReactNativeBlobUtil from "react-native-blob-util";
import { PermissionsAndroid, Platform } from "react-native";
import { UPDATE_CONFIG } from "@/constants/UpdateConfig";
import updateService from "@/services/updateService";

jest.mock("expo-file-system", () => ({
  documentDirectory: "file:///data/user/0/com.oriontv/files/",
  getInfoAsync: jest.fn(),
  getContentUriAsync: jest.fn(),
  createDownloadResumable: jest.fn(),
  readDirectoryAsync: jest.fn(),
  deleteAsync: jest.fn(),
  moveAsync: jest.fn(),
}));

jest.mock("expo-intent-launcher", () => ({
  startActivityAsync: jest.fn(),
}));

jest.mock("react-native-blob-util", () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: {
        SDCardDir: "/storage/emulated/0",
        DownloadDir: "/storage/emulated/0/Download",
      },
      cp: jest.fn(),
      exists: jest.fn(),
      mkdir: jest.fn(),
      stat: jest.fn(),
      unlink: jest.fn(),
    },
    android: {
      actionViewIntent: jest.fn(),
    },
  },
}));

jest.mock("react-native/Libraries/PermissionsAndroid/PermissionsAndroid", () => ({
  PERMISSIONS: { WRITE_EXTERNAL_STORAGE: "android.permission.WRITE_EXTERNAL_STORAGE" },
  RESULTS: { GRANTED: "granted", DENIED: "denied", NEVER_ASK_AGAIN: "never_ask_again" },
  check: jest.fn(),
  request: jest.fn(),
}));

jest.mock("@/utils/Toast", () => ({
  __esModule: true,
  default: {
    show: jest.fn(),
  },
}));

jest.mock("@/utils/Logger", () => ({
  __esModule: true,
  default: {
    withTag: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}));

describe("UpdateService.checkVersion", () => {
  const originalFetch = global.fetch;

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("读取 GitHub 最新 release tag 作为版本", async () => {
    const assetUrl = "https://github.com/yaniswang/OrionTV/releases/download/v1.4.2/orionTV.1.4.2-universal.apk";
    const json = jest.fn().mockResolvedValue({
      tag_name: "v1.4.2",
      body: "- 修复投屏问题\n- 修复其它小问题",
      published_at: "2026-10-08T03:40:39Z",
      assets: [
        {
          name: "orionTV.1.4.2-universal.apk",
          browser_download_url: assetUrl,
        },
      ],
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json }) as unknown as typeof fetch;

    const versionInfo = await updateService.checkVersion();

    expect(global.fetch).toHaveBeenCalledWith(
      UPDATE_CONFIG.GITHUB_LATEST_RELEASE_URL,
      expect.objectContaining({ signal: expect.anything() })
    );
    expect(versionInfo).toEqual({
      version: "1.4.2",
      fileName: "orionTV.1.4.2.apk",
      downloadUrl: `https://v4.gh-proxy.org/${assetUrl}`,
      releaseNotes: "- 修复投屏问题\n- 修复其它小问题",
      publishedAt: "2026-10-08T03:40:39Z",
    });
  });
});

describe("UpdateService.installApk", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    (FileSystem.getContentUriAsync as jest.Mock).mockResolvedValue(
      "content://com.oriontv.FileSystemFileProvider/files/OrionTV_v1.apk"
    );
    (IntentLauncher.startActivityAsync as jest.Mock).mockResolvedValue(undefined);
    (ReactNativeBlobUtil.fs.cp as jest.Mock).mockResolvedValue(undefined);
    (ReactNativeBlobUtil.android.actionViewIntent as jest.Mock).mockResolvedValue(undefined);
    (ReactNativeBlobUtil.fs.exists as jest.Mock).mockResolvedValue(false);
    (ReactNativeBlobUtil.fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (ReactNativeBlobUtil.fs.stat as jest.Mock).mockResolvedValue({ size: 4096 });
    (ReactNativeBlobUtil.fs.unlink as jest.Mock).mockResolvedValue(undefined);
    (PermissionsAndroid.check as jest.Mock).mockResolvedValue(false);
    (PermissionsAndroid.request as jest.Mock).mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
  });

  it("Android 6 复制到应用专属外部目录并使用 file URI 调起安装器，不申请存储权限", async () => {
    Object.defineProperty(Platform, "Version", { value: 23, configurable: true });
    const fileUri = "file:///data/user/0/com.oriontv/files/OrionTV_v1.apk";

    await updateService.installApk(fileUri);

    expect(ReactNativeBlobUtil.fs.mkdir).toHaveBeenCalledWith(
      "/storage/emulated/0/Android/data/com.oriontv/files/Download",
    );
    expect(ReactNativeBlobUtil.fs.cp).toHaveBeenCalledWith(
      fileUri,
      "/storage/emulated/0/Android/data/com.oriontv/files/Download/OrionTV_v1.apk",
    );
    expect(ReactNativeBlobUtil.android.actionViewIntent).toHaveBeenCalledWith(
      "/storage/emulated/0/Android/data/com.oriontv/files/Download/OrionTV_v1.apk",
      "application/vnd.android.package-archive"
    );
    expect(PermissionsAndroid.request).not.toHaveBeenCalled();
    expect(FileSystem.getContentUriAsync).not.toHaveBeenCalled();
    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
  });

  it("Android 6 应用专属目录中同版本已复制过时跳过复制", async () => {
    Object.defineProperty(Platform, "Version", { value: 23, configurable: true });
    (ReactNativeBlobUtil.fs.exists as jest.Mock).mockResolvedValue(true);
    (ReactNativeBlobUtil.fs.stat as jest.Mock).mockResolvedValue({ size: 4096 });

    await updateService.installApk(
      "file:///data/user/0/com.oriontv/files/OrionTV_1.4.12.apk",
    );

    expect(ReactNativeBlobUtil.fs.cp).not.toHaveBeenCalled();
    expect(ReactNativeBlobUtil.android.actionViewIntent).toHaveBeenCalledWith(
      "/storage/emulated/0/Android/data/com.oriontv/files/Download/OrionTV_1.4.12.apk",
      "application/vnd.android.package-archive",
    );
  });

  it("Android 6 应用专属目录安装器启动失败时，申请权限并回退公共 Download", async () => {
    Object.defineProperty(Platform, "Version", { value: 23, configurable: true });
    (ReactNativeBlobUtil.android.actionViewIntent as jest.Mock)
      .mockRejectedValueOnce(new Error("Activity not found"))
      .mockResolvedValueOnce(undefined);
    const fileUri = "file:///data/user/0/com.oriontv/files/OrionTV_v1.apk";

    await updateService.installApk(fileUri);

    expect(ReactNativeBlobUtil.android.actionViewIntent).toHaveBeenNthCalledWith(
      1,
      "/storage/emulated/0/Android/data/com.oriontv/files/Download/OrionTV_v1.apk",
      "application/vnd.android.package-archive",
    );
    expect(PermissionsAndroid.request).toHaveBeenCalledWith(
      "android.permission.WRITE_EXTERNAL_STORAGE",
      expect.any(Object),
    );
    expect(ReactNativeBlobUtil.fs.cp).toHaveBeenLastCalledWith(
      fileUri,
      "/storage/emulated/0/Download/OrionTV_v1.apk",
    );
    expect(ReactNativeBlobUtil.android.actionViewIntent).toHaveBeenNthCalledWith(
      2,
      "/storage/emulated/0/Download/OrionTV_v1.apk",
      "application/vnd.android.package-archive",
    );
  });

  it("Android 6 回退时拒绝存储权限则不再调起公共目录安装", async () => {
    Object.defineProperty(Platform, "Version", { value: 23, configurable: true });
    (ReactNativeBlobUtil.android.actionViewIntent as jest.Mock).mockRejectedValueOnce(
      new Error("Activity not found"),
    );
    (PermissionsAndroid.request as jest.Mock).mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);

    await expect(
      updateService.installApk("file:///data/user/0/com.oriontv/files/OrionTV_v1.apk"),
    ).rejects.toThrow("WRITE_EXTERNAL_STORAGE denied");

    expect(ReactNativeBlobUtil.fs.cp).toHaveBeenCalledTimes(1);
    expect(ReactNativeBlobUtil.android.actionViewIntent).toHaveBeenCalledTimes(1);
  });

  it("Android 7+ 使用 content URI 调起安装器", async () => {
    Object.defineProperty(Platform, "Version", { value: 24, configurable: true });
    const fileUri = "file:///data/user/0/com.oriontv/files/OrionTV_v1.apk";

    await updateService.installApk(fileUri);

    expect(FileSystem.getContentUriAsync).toHaveBeenCalledWith(fileUri);
    expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith(
      "android.intent.action.VIEW",
      expect.objectContaining({
        data: "content://com.oriontv.FileSystemFileProvider/files/OrionTV_v1.apk",
        type: "application/vnd.android.package-archive",
        flags: 1 | 0x10000000,
      })
    );
    expect(ReactNativeBlobUtil.fs.cp).not.toHaveBeenCalled();
    expect(ReactNativeBlobUtil.android.actionViewIntent).not.toHaveBeenCalled();
    expect(PermissionsAndroid.request).not.toHaveBeenCalled();
  });

  it("安装器未返回前不会重复调起 IntentLauncher", async () => {
    Object.defineProperty(Platform, "Version", { value: 24, configurable: true });
    const fileUri = "file:///data/user/0/com.oriontv/files/OrionTV_v1.apk";
    let resolveStart!: () => void;
    (IntentLauncher.startActivityAsync as jest.Mock).mockImplementation(
      () => new Promise<void>(resolve => {
        resolveStart = resolve;
      })
    );

    const firstInstall = updateService.installApk(fileUri);
    const secondInstall = updateService.installApk(fileUri);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(IntentLauncher.startActivityAsync).toHaveBeenCalledTimes(1);
    resolveStart();
    await Promise.all([firstInstall, secondInstall]);
  });
});

describe("UpdateService.downloadApk", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue([]);
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.moveAsync as jest.Mock).mockResolvedValue(undefined);
  });

  it("同名安装包已存在时跳过下载", async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 1024 * 1024 });
    const progress = jest.fn();

    const uri = await updateService.downloadApk(
      "https://example.com/orionTV.1.4.12-universal.apk",
      "orionTV.1.4.12.apk",
      progress,
    );

    expect(uri).toBe("file:///data/user/0/com.oriontv/files/orionTV.1.4.12.apk");
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(100);
  });

  it("下载先写 .part，完整后再改成版本号文件名", async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    (FileSystem.createDownloadResumable as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue({
        status: 200,
        uri: "file:///data/user/0/com.oriontv/files/orionTV.1.4.12.apk.part",
      }),
    });

    const uri = await updateService.downloadApk(
      "https://example.com/x.apk",
      "orionTV.1.4.12.apk",
    );

    expect(FileSystem.createDownloadResumable).toHaveBeenCalledWith(
      "https://example.com/x.apk",
      "file:///data/user/0/com.oriontv/files/orionTV.1.4.12.apk.part",
      expect.any(Object),
      expect.any(Function),
    );
    expect(FileSystem.moveAsync).toHaveBeenCalledWith({
      from: "file:///data/user/0/com.oriontv/files/orionTV.1.4.12.apk.part",
      to: "file:///data/user/0/com.oriontv/files/orionTV.1.4.12.apk",
    });
    expect(uri).toBe("file:///data/user/0/com.oriontv/files/orionTV.1.4.12.apk");
  });
});
