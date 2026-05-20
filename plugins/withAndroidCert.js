const { withDangerousMod, withAndroidManifest } = require('@expo/config-plugins');
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

// 2. 写入配置文件并复制证书文件到原生 Android 目录
function withCertFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const { projectRoot } = config.modRequest;
      
      // 路径定义
      const resDir = path.join(projectRoot, 'android/app/src/main/res');
      const xmlDir = path.join(resDir, 'xml');
      const rawDir = path.join(resDir, 'raw');
      
      // 确保 xml 和 raw 文件夹存在
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.mkdirSync(rawDir, { recursive: true });

      // 网络安全配置文件的 XML 内容
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

      // 写入 xml 配置文件
      fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), networkSecurityConfigXml);

      fs.copyFileSync(path.join(projectRoot, 'plugins/isrg_root_x1.cer'), path.join(rawDir, 'isrg_root_x1.cer'));
      fs.copyFileSync(path.join(projectRoot, 'plugins/isrg_root_x2.cer'), path.join(rawDir, 'isrg_root_x2.cer'));
      console.log('✅ isrg根证书已成功复制到原生 Android 目录');

      return config;
    },
  ]);
}

// 导出组合后的插件
module.exports = function withAndroidCert(config) {
  return withNetworkSecurityConfigManifest(withCertFiles(config));
};
