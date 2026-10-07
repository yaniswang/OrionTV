import React from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Cast, Check, RefreshCw, Wifi } from 'lucide-react-native';
import { StyledButton } from './StyledButton';
import useDlnaStore from '@/stores/dlnaStore';
import type { DLNADevice } from '@/services/dlna/types';

interface DLNACastPanelProps {
  onBackgroundPress: () => void;
}

export const DLNACastPanel: React.FC<DLNACastPanelProps> = ({ onBackgroundPress }) => {
  const phase = useDlnaStore((state) => state.phase);
  const devices = useDlnaStore((state) => state.devices);
  const currentDevice = useDlnaStore((state) => state.currentDevice);
  const connectingDeviceId = useDlnaStore((state) => state.connectingDeviceId);
  const error = useDlnaStore((state) => state.error);
  const refreshDevices = useDlnaStore((state) => state.refreshDevices);
  const selectDevice = useDlnaStore((state) => state.selectDevice);

  const renderDevice = ({ item }: { item: DLNADevice }) => {
    const selected = currentDevice?.id === item.id;
    const connecting = connectingDeviceId === item.id;
    return (
      <Pressable
        onPress={() => void selectDevice(item)}
        style={({ pressed }) => [styles.deviceRow, selected && styles.deviceRowSelected, pressed && styles.deviceRowPressed]}
      >
        <View style={styles.deviceIcon}>
          {selected ? <Check color="#00bb5e" size={22} /> : <Cast color="#bbb" size={22} />}
        </View>
        <View style={styles.deviceInfo}>
          <Text numberOfLines={1} style={styles.deviceName}>{item.friendlyName}</Text>
          <Text numberOfLines={1} style={styles.deviceMeta}>
            {[item.modelName, item.address].filter(Boolean).join(' · ') || item.location}
          </Text>
        </View>
        {connecting && <ActivityIndicator color="#00bb5e" />}
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onBackgroundPress} />
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <Cast color="#00bb5e" size={24} />
            <Text style={styles.title}>DLNA 投屏</Text>
          </View>
          <Pressable onPress={() => void refreshDevices()} style={styles.refreshButton}>
            <RefreshCw color="white" size={20} />
          </Pressable>
        </View>

        <Text style={styles.hint}>
          {currentDevice ? `正在投屏到 ${currentDevice.friendlyName}，点击其他设备可立即切换` : '选择同一局域网内的电视或播放设备'}
        </Text>

        {phase === 'scanning' && devices.length === 0 && (
          <View style={styles.centerState}>
            <ActivityIndicator color="#00bb5e" size="large" />
            <Text style={styles.stateText}>正在搜索 DLNA 设备…</Text>
          </View>
        )}

        {devices.length > 0 && (
          <FlatList
            data={devices}
            keyExtractor={(item) => item.id}
            renderItem={renderDevice}
            style={styles.list}
            contentContainerStyle={styles.listContent}
          />
        )}

        {!error && phase !== 'scanning' && devices.length === 0 && (
          <View style={styles.centerState}>
            <Wifi color="#888" size={34} />
            <Text style={styles.stateText}>未发现设备，请确认电视已开启且与手机处于同一网络</Text>
            <StyledButton text="重新搜索" onPress={() => void refreshDevices({ autoConnectLast: false })} />
          </View>
        )}

        {!!error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {devices.length > 0 && phase === 'scanning' && (
          <View style={styles.scanningFooter}>
            <ActivityIndicator color="#00bb5e" />
            <Text style={styles.stateText}>继续搜索中…</Text>
          </View>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'black',
  },
  card: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '78%',
    borderRadius: 16,
    padding: 18,
    backgroundColor: 'rgba(20, 20, 20, 0.96)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: 'white',
    fontSize: 20,
    fontWeight: '700',
  },
  refreshButton: {
    padding: 8,
  },
  hint: {
    color: '#aaa',
    fontSize: 13,
    marginTop: 8,
    marginBottom: 12,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    gap: 8,
  },
  deviceRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#292929',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  deviceRowSelected: {
    borderColor: '#00bb5e',
    backgroundColor: 'rgba(0,187,94,0.14)',
  },
  deviceRowPressed: {
    opacity: 0.78,
  },
  deviceIcon: {
    width: 32,
    alignItems: 'center',
  },
  deviceInfo: {
    flex: 1,
    marginHorizontal: 6,
  },
  deviceName: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  deviceMeta: {
    color: '#999',
    fontSize: 12,
    marginTop: 3,
  },
  centerState: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 170,
    gap: 12,
    paddingHorizontal: 24,
  },
  stateText: {
    color: '#aaa',
    textAlign: 'center',
    lineHeight: 20,
  },
  errorBox: {
    marginTop: 12,
    borderRadius: 8,
    padding: 10,
    backgroundColor: 'rgba(255, 80, 80, 0.16)',
  },
  errorText: {
    color: '#ff8a8a',
    textAlign: 'center',
  },
  scanningFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingTop: 10,
  },
});
