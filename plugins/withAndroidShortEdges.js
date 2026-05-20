const { withAndroidStyles, AndroidConfig } = require('@expo/config-plugins');

const withAndroidShortEdges = (config) => {
  return withAndroidStyles(config, (modConfig) => {
    // 找到 AppTheme 样式并在其中注入 shortEdges 配置
    modConfig.modResults = AndroidConfig.Styles.assignStylesValue(modConfig.modResults, {
      add: true,
      parent: { name: 'AppTheme', parent: 'Theme.AppCompat.Light.NoActionBar' }, // 确保与你原生的 parent 一致
      name: 'android:windowLayoutInDisplayCutoutMode',
      value: 'shortEdges',
    });
    return modConfig;
  });
};

module.exports = withAndroidShortEdges;
