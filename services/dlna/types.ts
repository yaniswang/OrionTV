export type DLNACastPhase =
  | 'idle'
  | 'scanning'
  | 'selecting'
  | 'connecting'
  | 'connected'
  | 'error';

export type DLNATransportState =
  | 'PLAYING'
  | 'PAUSED_PLAYBACK'
  | 'STOPPED'
  | 'TRANSITIONING'
  | 'NO_MEDIA_PRESENT'
  | 'UNKNOWN';

export interface DLNADevice {
  id: string;
  udn: string;
  friendlyName: string;
  manufacturer?: string;
  modelName?: string;
  location: string;
  controlUrl: string;
  eventSubUrl?: string;
  serviceType: string;
  address?: string;
  renderingControlUrl?: string;
  renderingControlServiceType?: string;
  hasRenderingControlService?: boolean;
}

export interface DLNAControlCapabilities {
  actions: string[];
  canPlay: boolean;
  canPause: boolean;
  canStop: boolean;
  canSeek: boolean;
}

export interface DLNATransportInfo {
  state: DLNATransportState;
  status: string;
}

export interface DLNAMediaInfo {
  /** 当前媒体地址（AVTransportURI）；为空表示电视已没有可播放的媒体 */
  currentUri: string;
  /** 曲目数（NrTracks）；无法解析时为 null */
  numberOfTracks: number | null;
}

export interface DLNAPositionInfo {
  trackDurationMillis: number;
  positionMillis: number;
  /** 设备是否真的提供位置信息；为 false 表示 RelTime 返回 NOT_IMPLEMENTED。 */
  positionSupported: boolean;
  trackUri: string;
}
