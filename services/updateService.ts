// UpdateService.ts
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
// import * as Device from 'expo-device';
import Toast from '@/utils/Toast';
import { version as currentVersion } from '../package.json';
import { UPDATE_CONFIG } from '../constants/UpdateConfig';
import Logger from '@/utils/Logger';
import { PermissionsAndroid, Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

const logger = Logger.withTag('UpdateService');

interface VersionInfo {
  version: string;
  /** GitHub release 里的 APK 文件名，本地保持一致，方便"已存在就跳过下载" */
  fileName: string;
  downloadUrl: string;
  releaseNotes: string;
  publishedAt: string;
}

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubRelease {
  tag_name?: string;
  body?: string;
  published_at?: string;
  assets?: GitHubReleaseAsset[];
}

/**
 * 只在 Android 平台使用的常量（iOS 不会走到下载/安装流程）
 */
const ANDROID_MIME_TYPE = 'application/vnd.android.package-archive';

class UpdateService {
  private installInProgress = false;
  private static instance: UpdateService;
  static getInstance(): UpdateService {
    if (!UpdateService.instance) {
      UpdateService.instance = new UpdateService();
    }
    return UpdateService.instance;
  }

  /** --------------------------------------------------------------
   *  1️⃣ 从 GitHub Releases 获取最新版本
   * --------------------------------------------------------------- */
  async checkVersion(): Promise<VersionInfo> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch(UPDATE_CONFIG.GITHUB_LATEST_RELEASE_URL, {
          headers: {
            Accept: 'application/vnd.github+json',
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const release = (await response.json()) as GitHubRelease;
        if (!release.tag_name) {
          throw new Error('Latest release tag not found');
        }
        const remoteVersion = release.tag_name.replace(/^v/i, '');
        const exactAssetName = `orionTV.${remoteVersion}.apk`;
        const apkAsset =
          release.assets?.find(asset => asset.name === exactAssetName) ??
          release.assets?.find(asset => asset.name?.toLowerCase().endsWith('.apk'));
        if (!apkAsset?.browser_download_url) {
          throw new Error('Latest release APK asset not found');
        }
        // 本地文件名固定为 orionTV.<版本>.apk，版本号拼进文件名，便于判断是否已下载
        const fileName = `orionTV.${remoteVersion}.apk`;
        return {
          version: remoteVersion,
          fileName,
          downloadUrl: UPDATE_CONFIG.getDownloadUrl(apkAsset.browser_download_url),
          releaseNotes: release.body?.trim() ?? '',
          publishedAt: release.published_at ?? '',
        };
      } catch (e) {
        logger.warn(`checkVersion attempt ${attempt}/${maxRetries}`, e);
        if (attempt === maxRetries) {
          Toast.show({
            type: 'error',
            text1: '检查更新失败',
            text2: '无法获取版本信息，请检查网络',
          });
          throw e;
        }
        // 指数退避
        await new Promise(r => setTimeout(r, 2_000 * attempt));
      }
    }
    // 这句永远走不到，仅为 TypeScript 报错
    throw new Error('Unexpected');
  }

  /** --------------------------------------------------------------
   *  2️⃣ 清理旧的 APK 文件（使用 expo-file-system 的 API）
   * --------------------------------------------------------------- */
  private async cleanOldApkFiles(): Promise<void> {
    try {
      const dirUri = FileSystem.documentDirectory; // e.g. file:///data/user/0/.../files/
      if (!dirUri) {
        throw new Error('Document directory is not available');
      }
      const listing = await FileSystem.readDirectoryAsync(dirUri);
      // 清理上次中断留下的临时文件
      for (const name of listing.filter(name => name.endsWith('.apk.part'))) {
        await FileSystem.deleteAsync(`${dirUri}${name}`, { idempotent: true }).catch(() => {});
      }
      const apkFiles = listing.filter(name => /^oriontv.*\.apk$/i.test(name));

      if (apkFiles.length <= 2) return;

      const withTime = await Promise.all(
        apkFiles.map(async name => {
          const info = await FileSystem.getInfoAsync(`${dirUri}${name}`);
          return { name, time: info.exists ? info.modificationTime ?? 0 : 0 };
        }),
      );
      const sorted = withTime.sort((a, b) => b.time - a.time).map(item => item.name);

      const stale = sorted.slice(2); // 保留最新的两个
      for (const file of stale) {
        const path = `${dirUri}${file}`;
        try {
          await FileSystem.deleteAsync(path, { idempotent: true });
          logger.debug(`Deleted old APK: ${file}`);
        } catch (e) {
          logger.warn(`Failed to delete ${file}`, e);
        }
      }
    } catch (e) {
      logger.warn('cleanOldApkFiles error', e);
    }
  }

  /** --------------------------------------------------------------
   *  3️⃣ 下载 APK（使用 expo-file-system 的下载 API）
   * --------------------------------------------------------------- */
  async downloadApk(
    url: string,
    fileName: string,
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    const maxRetries = 3;
    await this.cleanOldApkFiles();

    const localName = fileName.replace(/[\\/]/g, '_');
    const fileUri = `${FileSystem.documentDirectory}${localName}`;
    const partUri = `${fileUri}.part`;

    // 同名安装包已经下载过：跳过下载，直接复用现有安装包
    const existing = await FileSystem.getInfoAsync(fileUri);
    if (existing.exists && (existing.size ?? 0) > 0) {
      logger.debug(`APK already downloaded: ${localName}`);
      onProgress?.(100);
      return fileUri;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 先写到 .part，下载完整后再改名，避免把半截文件当成"已下载"
        await FileSystem.deleteAsync(partUri, { idempotent: true });

        // expo-file-system 把下载进度回调参数统一为 `{totalBytesWritten, totalBytesExpectedToWrite}`
        const downloadResumable = FileSystem.createDownloadResumable(
          url,
          partUri,
          {
            // Android 需要在 AndroidManifest 中声明 INTERNET、WRITE_EXTERNAL_STORAGE (API 33+ 使用 MANAGE_EXTERNAL_STORAGE)
            // 这里不使用系统下载管理器，因为我们想自己控制进度回调。
          },
          progress => {
            if (onProgress && progress.totalBytesExpectedToWrite > 0) {
              const percent = Math.floor(
                (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * 100,
              );
              onProgress(percent);
            }
          },
        );
        const result = await downloadResumable.downloadAsync();
        if (!result || result.status !== 200) {
          await FileSystem.deleteAsync(partUri, { idempotent: true }).catch(() => {});
          throw new Error('更新失败，没有发现有效APK文件！');
        }
        await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
        await FileSystem.moveAsync({ from: partUri, to: fileUri });
        logger.debug(`APK downloaded to ${fileUri}`);
        return fileUri;
      } catch (e) {
        await FileSystem.deleteAsync(partUri, { idempotent: true }).catch(() => {});
        logger.warn(`downloadApk attempt ${attempt}/${maxRetries}`, e);
        if (attempt === maxRetries) {
          Toast.show({
            type: 'error',
            text1: '下载失败',
            text2: 'APK 下载出现错误，请检查网络',
          });
          throw e;
        }
        // 指数退避
        await new Promise(r => setTimeout(r, 3_000 * attempt));
      }
    }
    // 同上，理论不会到这里
    throw new Error('Download failed');
  }

  // 防止重复点击导致同时启动多个系统安装 Activity
  async installApk(fileUri: string): Promise<void> {
    if (this.installInProgress) {
      logger.warn('APK install already in progress');
      return;
    }

    this.installInProgress = true;
    try {
      await this.installApkInternal(fileUri);
    } finally {
      this.installInProgress = false;
    }
  }

  /**
   * Android 6（API 23）回退到公共 Download 目录前必须申请运行时存储权限。
   * 只在清单里声明是不够的，否则写入时会报 "open failed: EACCES (Permission denied)"。
   */
  private async ensureLegacyStoragePermission(): Promise<void> {
    const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
    if (await PermissionsAndroid.check(permission)) return;
    const result = await PermissionsAndroid.request(permission, {
      title: '需要存储权限',
      message: '应用专属目录安装失败，更新包需要复制到下载目录后重试。',
      buttonPositive: '允许',
      buttonNegative: '取消',
    });
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      Toast.show({
        type: 'error',
        text1: '安装失败',
        text2: '没有存储权限，无法写入下载目录',
      });
      throw new Error('WRITE_EXTERNAL_STORAGE denied');
    }
  }

  /** Android 6 的安装器不支持 content://，需要把 APK 放到安装器可读取的外部路径。 */
  private getLegacyExternalDownloadDir(fileUri: string): string {
    const match = fileUri.match(/^file:\/\/\/data\/(?:user\/\d+|data)\/([^/]+)/);
    if (!match?.[1]) {
      throw new Error(`Cannot resolve Android package name from ${fileUri}`);
    }
    const externalRoot = ReactNativeBlobUtil.fs.dirs.SDCardDir.replace(/\/+$/, '');
    return `${externalRoot}/Android/data/${match[1]}/files/Download`;
  }

  private async copyApkToDirectory(
    fileUri: string,
    targetDir: string,
    fileName: string,
  ): Promise<string> {
    if (!(await ReactNativeBlobUtil.fs.exists(targetDir))) {
      await ReactNativeBlobUtil.fs.mkdir(targetDir);
    }

    const targetPath = `${targetDir}/${fileName}`;
    const copied = await ReactNativeBlobUtil.fs.exists(targetPath);
    const sourceSize = (await ReactNativeBlobUtil.fs.stat(fileUri)).size;
    const targetSize = copied ? (await ReactNativeBlobUtil.fs.stat(targetPath)).size : -1;
    if (!copied || targetSize !== sourceSize) {
      if (copied) await ReactNativeBlobUtil.fs.unlink(targetPath).catch(() => {});
      await ReactNativeBlobUtil.fs.cp(fileUri, targetPath);
    }
    return targetPath;
  }

  private async installLegacyApk(fileUri: string): Promise<void> {
    const fileName = fileUri.split('/').pop() ?? `orionTV.${currentVersion}.apk`;
    try {
      const appSpecificPath = await this.copyApkToDirectory(
        fileUri,
        this.getLegacyExternalDownloadDir(fileUri),
        fileName,
      );
      await ReactNativeBlobUtil.android.actionViewIntent(appSpecificPath, ANDROID_MIME_TYPE);
      return;
    } catch (error) {
      logger.warn('App-specific external APK install failed, falling back to public Download', error);
    }

    await this.ensureLegacyStoragePermission();
    const publicPath = await this.copyApkToDirectory(
      fileUri,
      ReactNativeBlobUtil.fs.dirs.DownloadDir,
      fileName,
    );
    await ReactNativeBlobUtil.android.actionViewIntent(publicPath, ANDROID_MIME_TYPE);
  }

  /** --------------------------------------------------------------
   *  4️⃣ 安装 APK（只在 Android 可用，使用 expo-intent-launcher）
   * --------------------------------------------------------------- */
  private async installApkInternal(fileUri: string): Promise<void> {
    // ① 先确认文件存在
    const exists = await FileSystem.getInfoAsync(fileUri);
    if (!exists.exists) {
      throw new Error(`APK not found at ${fileUri}`);
    }

    // ② 只在 Android 里执行
    if (Platform.OS === 'android') {
      // Android 6 的安装器不支持 content://，优先使用应用专属外部目录和 file://。
      // 该目录不需要存储权限；只有安装器无法读取时才回退到公共 Download。
      if (Platform.Version < 24) {
        await this.installLegacyApk(fileUri);
        return;
      }

      // Android 7.0+ 使用 content://
      const contentUri = await FileSystem.getContentUriAsync(fileUri);
      const flags = 1 | 0x10000000;
      try {
        // 尝试标准安装
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: contentUri,
          type: ANDROID_MIME_TYPE,   // application/vnd.android.package-archive
          flags,
        });
      } catch (e: any) {
        try {
          // 失败后尝试使用老版本专用的安装 Action
          await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
            data: contentUri,
            type: ANDROID_MIME_TYPE,
            flags,
            packageName: 'com.android.packageinstaller',
            className: 'com.android.packageinstaller.PackageInstallerActivity'
          });
        }
        catch(e: any) {
          // 统一错误提示
          if (e.message?.includes('Activity not found')) {
            Toast.show({
              type: 'error',
              text1: '安装失败',
              text2: '系统没有找到可以打开 APK 的应用，请检查系统设置',
            });
          } else if (e.message?.includes('permission')) {
            Toast.show({
              type: 'error',
              text1: '安装失败',
              text2: '请在设置里允许“未知来源”安装',
            });
          } else {
            Toast.show({
              type: 'error',
              text1: '安装失败',
              text2: '未知错误，请稍后重试',
            });
          }
          throw e;
        }
      }
    } else {
      // iOS 设备不支持直接安装 APK
      Toast.show({
        type: 'error',
        text1: '安装失败',
        text2: 'iOS 设备无法直接安装 APK',
      });
      throw new Error('APK install not supported on iOS');
    }
  }

  /** --------------------------------------------------------------
   *  5️⃣ 版本比对工具（保持原来的实现）
   * --------------------------------------------------------------- */
  compareVersions(v1: string, v2: string): number {
    const p1 = v1.split('.').map(Number);
    const p2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const n1 = p1[i] ?? 0;
      const n2 = p2[i] ?? 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }
  getCurrentVersion(): string {
    return currentVersion;
  }
  isUpdateAvailable(remoteVersion: string): boolean {
    return this.compareVersions(remoteVersion, currentVersion) > 0;
  }
}

/* 单例导出 */
export default UpdateService.getInstance();
