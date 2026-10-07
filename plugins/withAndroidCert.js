const {
  withDangerousMod,
  withAndroidManifest,
  withMainApplication,
  withAppBuildGradle,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// 1. 修改 AndroidManifest.xml，关联网络安全配置文件
function withNetworkSecurityConfigManifest(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults;
    const mainApplication = androidManifest.manifest.application[0];

    // 给 <application> 标签添加 android:networkSecurityConfig 属性
    mainApplication.$['android:networkSecurityConfig'] = '@xml/network_security_config';

    return config;
  });
}

// 2. 写入配置文件、证书和旧 Android TLS 支持代码
function withCertFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const { projectRoot } = config.modRequest;

      // 路径定义
      const resDir = path.join(projectRoot, 'android/app/src/main/res');
      const xmlDir = path.join(resDir, 'xml');
      const rawDir = path.join(resDir, 'raw');
      const javaDir = path.join(projectRoot, 'android/app/src/main/java/com/oriontv');

      // 确保资源目录存在
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.mkdirSync(rawDir, { recursive: true });
      fs.mkdirSync(javaDir, { recursive: true });

      // 网络安全配置：API 24+ 的兜底方案
      const networkSecurityConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
      <base-config cleartextTrafficPermitted="true">
          <trust-anchors>
              <!-- 信任系统预装的 CA 证书 -->
              <certificates src="system" />
              <!-- 信任 raw 目录下的自签名证书 -->
              <certificates src="@raw/isrg_root_x1" />
              <certificates src="@raw/isrg_root_x2" />
          </trust-anchors>
      </base-config>
  </network-security-config>`;

      fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), networkSecurityConfigXml);
      fs.copyFileSync(path.join(projectRoot, 'plugins/isrg_root_x1.cer'), path.join(rawDir, 'isrg_root_x1.cer'));
      fs.copyFileSync(path.join(projectRoot, 'plugins/isrg_root_x2.cer'), path.join(rawDir, 'isrg_root_x2.cer'));
      fs.copyFileSync(path.join(projectRoot, 'plugins/LegacyTls.kt'), path.join(javaDir, 'LegacyTls.kt'));
      fs.copyFileSync(path.join(projectRoot, 'plugins/MediaProxyModule.kt'), path.join(javaDir, 'MediaProxyModule.kt'));
      fs.copyFileSync(path.join(projectRoot, 'plugins/MediaProxyPlaylist.kt'), path.join(javaDir, 'MediaProxyPlaylist.kt'));
      const testDir = path.join(projectRoot, 'android/app/src/test/java/com/oriontv');
      fs.mkdirSync(testDir, { recursive: true });
      fs.copyFileSync(path.join(projectRoot, 'plugins/MediaProxyPlaylistTest.kt'), path.join(testDir, 'MediaProxyPlaylistTest.kt'));
      console.log('✅ ISRG 根证书和旧 Android TLS 支持代码已复制到原生 Android 目录');

      return config;
    },
  ]);
}

// 3. 在 MainApplication.onCreate 中初始化全局 OkHttp TLS 配置
function withLegacyTlsMainApplication(config) {
  return withMainApplication(config, (config) => {
    const mainApplication = config.modResults;
    let contents = mainApplication.contents;
    const isKotlin = contents.includes('override fun onCreate');
    const configureCall = isKotlin ? 'LegacyTls.configure(this)' : 'LegacyTls.INSTANCE.configure(this);';

    if (!contents.includes(configureCall)) {
      const onCreatePattern = isKotlin
        ? /(override fun onCreate\(\) \{\s*super\.onCreate\(\))/
        : /(public void onCreate\(\) \{\s*super\.onCreate\(\);?)/;

      if (!onCreatePattern.test(contents)) {
        throw new Error('无法在 MainApplication.onCreate 中初始化 LegacyTls');
      }

      contents = contents.replace(onCreatePattern, `$1\n    ${configureCall}`);
      mainApplication.contents = contents;
    }

    return config;
  });
}

// 导出组合后的插件
// 4. 注册流式回源的原生模块
function withMediaProxyPackage(config) {
  return withMainApplication(config, (config) => {
    const mainApplication = config.modResults;
    let contents = mainApplication.contents;

    if (!contents.includes('MediaProxyPackage()')) {
      const target = /return PackageList\(this\)\.packages/;
      if (!target.test(contents)) {
        throw new Error('无法在 MainApplication.getPackages 中注册 MediaProxyPackage');
      }
      contents = contents.replace(
        target,
        'val packages = PackageList(this).packages\n            packages.add(MediaProxyPackage())\n            return packages',
      );
      mainApplication.contents = contents;
    }

    return config;
  });
}

module.exports = function withAndroidCert(config) {
  return withMediaProxyUnitTest(
    withMediaProxyPackage(
      withLegacyTlsMainApplication(
        withNetworkSecurityConfigManifest(withCertFiles(config)),
      ),
    ),
  );
};

// 4.5 让原生清单改写逻辑能在 JVM 上跑等价性单测
function withMediaProxyUnitTest(config) {
  return withAppBuildGradle(config, (config) => {
    const gradle = config.modResults;
    if (gradle.language !== 'groovy') return config;
    if (!gradle.contents.includes('MediaProxyUnitTest')) {
      const anchor = 'implementation("com.facebook.react:react-android")';
      if (!gradle.contents.includes(anchor)) {
        throw new Error('无法在 app/build.gradle 中注入 JUnit 依赖');
      }
      gradle.contents = gradle.contents.replace(
        anchor,
        `${anchor}
    // MediaProxyUnitTest: 原生清单改写与原 JS 实现的等价性单测
    testImplementation("junit:junit:4.13.2")`,
      );
    }
    return config;
  });
}
