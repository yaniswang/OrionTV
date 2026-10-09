import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { AlertCircle, Cast, CheckCircle2, Wifi } from 'lucide-react-native';
import useDlnaStore from '@/stores/dlnaStore';

const formatTime = (milliseconds: number): string => {
  if (!milliseconds) return '00:00';
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const transportLabel = (state: string): string => {
  switch (state) {
    case 'PLAYING':
      return '播放中';
    case 'PAUSED_PLAYBACK':
      return '已暂停';
    case 'STOPPED':
      return '已停止';
    case 'NO_MEDIA_PRESENT':
      return '无媒体';
    case 'TRANSITIONING':
      return '正在切换';
    default:
      return '状态同步中';
  }
};

interface DLNAStatusPanelProps {
  /** 直播投屏时传入当前频道名：不显示进度，改为显示频道 */
  liveTitle?: string;
}

export const DLNAStatusPanel: React.FC<DLNAStatusPanelProps> = ({ liveTitle }) => {
  const phase = useDlnaStore((state) => state.phase);
  const currentDevice = useDlnaStore((state) => state.currentDevice);
  const connectingDeviceName = useDlnaStore((state) => state.connectingDeviceName);
  const transportState = useDlnaStore((state) => state.transportState);
  const playbackConfirmed = useDlnaStore((state) => state.playbackConfirmed);
  const playbackEstablished = useDlnaStore((state) => state.playbackEstablished);
  const positionMillis = useDlnaStore((state) => state.positionMillis);
  const durationMillis = useDlnaStore((state) => state.durationMillis);
  const error = useDlnaStore((state) => state.error);
  const mediaLoading = useDlnaStore((state) => state.mediaLoading);

  const deviceName = currentDevice?.friendlyName ?? connectingDeviceName ?? '未选择设备';
  const busy = phase === 'scanning' || phase === 'connecting';
  const connected = phase === 'connected' && !!currentDevice;
  const phaseLabel = (() => {
    switch (phase) {
      case 'scanning':
        return '正在搜索投屏设备';
      case 'selecting':
        return '请选择投屏设备';
      case 'connecting':
        return `正在连接 ${deviceName}`;
      case 'connected':
        return playbackEstablished || playbackConfirmed ? '正在投屏中' : '开始投屏';
      case 'error':
        return '投屏异常';
      default:
        return 'DLNA 投屏';
    }
  })();

  const StatusIcon = phase === 'error' ? AlertCircle : connected ? CheckCircle2 : phase === 'scanning' ? Wifi : Cast;
  const accent = phase === 'error' ? '#ff6b6b' : connected ? '#00bb5e' : '#b9b9b9';
  const deviceMeta = currentDevice
    ? [currentDevice.modelName, currentDevice.address].filter(Boolean).join(' · ')
    : '';
  const playbackLabel = !playbackEstablished && transportState === 'PLAYING'
    ? '正在启动播放'
    : transportLabel(transportState);

  return (
    <View style={styles.container}>
      <View pointerEvents="none" style={styles.card}>
        <View style={[styles.iconWrap, { borderColor: accent }]}>
          <StatusIcon color={accent} size={36} />
        </View>
        <Text style={styles.title}>{phaseLabel}</Text>
        {connected && <Text style={styles.deviceName}>{deviceName}</Text>}
        {connected && !!deviceMeta && <Text style={styles.deviceMeta}>{deviceMeta}</Text>}
        {connected && liveTitle === undefined && (
          <Text style={styles.playbackText}>
            {playbackLabel}
            {durationMillis > 0 ? ` · ${formatTime(positionMillis)} / ${formatTime(durationMillis)}` : ''}
          </Text>
        )}
        {connected && liveTitle !== undefined && (
          <Text style={styles.playbackText}>
            {mediaLoading ? '正在切换频道' : playbackLabel} · {liveTitle}
          </Text>
        )}
        {busy && <ActivityIndicator color="#00bb5e" size="large" />}
        {!!error && <Text style={styles.errorText}>{error}</Text>}
        <Text style={styles.hint}>
          {liveTitle === undefined ? '点击右下角的切换设备按钮可更换投屏设备' : '点击屏幕可切换频道或投屏设备'}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: 'black',
  },
  card: {
    width: '100%',
    maxWidth: 520,
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingVertical: 30,
    borderRadius: 18,
  },
  iconWrap: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    color: 'white',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  deviceName: {
    color: '#00bb5e',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 10,
  },
  deviceMeta: {
    color: '#888',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 5,
  },
  playbackText: {
    color: '#d5d5d5',
    fontSize: 15,
    marginTop: 16,
  },
  errorText: {
    color: '#ff8a8a',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 14,
  },
  hint: {
    color: '#777',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 22,
  },
});
