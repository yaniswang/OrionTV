import * as FileSystem from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import ReactNativeBlobUtil from "react-native-blob-util";
import { Platform } from "react-native";
import updateService from "@/services/updateService";

jest.mock("expo-file-system", () => ({
  documentDirectory: "file:///data/user/0/com.oriontv/files/",
  getInfoAsync: jest.fn(),
  getContentUriAsync: jest.fn(),
  createDownloadResumable: jest.fn(),
  readDirectoryAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));

jest.mock("expo-intent-launcher", () => ({
  startActivityAsync: jest.fn(),
}));

jest.mock("react-native-blob-util", () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: {
        DownloadDir: "/storage/emulated/0/Android/data/com.oriontv/files/Download",
      },
      cp: jest.fn(),
    },
    android: {
      actionViewIntent: jest.fn(),
    },
  },
}));

jest.mock("react-native-toast-message", () => ({
  show: jest.fn(),
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
  });

  it("Android 6 复制到外部 Download 目录并使用 file URI 调起安装器", async () => {
    Object.defineProperty(Platform, "Version", { value: 23, configurable: true });
    const fileUri = "file:///data/user/0/com.oriontv/files/OrionTV_v1.apk";

    await updateService.installApk(fileUri);

    expect(ReactNativeBlobUtil.fs.cp).toHaveBeenCalledWith(
      fileUri,
      expect.stringMatching(/\/Download\/OrionTV_v\d+\.apk$/)
    );
    const downloadPath = (ReactNativeBlobUtil.fs.cp as jest.Mock).mock.calls[0][1];
    expect(ReactNativeBlobUtil.android.actionViewIntent).toHaveBeenCalledWith(
      downloadPath,
      "application/vnd.android.package-archive"
    );
    expect(FileSystem.getContentUriAsync).not.toHaveBeenCalled();
    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
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
  });
});
