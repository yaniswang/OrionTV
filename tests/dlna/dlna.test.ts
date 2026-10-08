/** @jest-environment node */

jest.mock('react-native-udp', () => ({
  __esModule: true,
  default: {
    createSocket: jest.fn(),
  },
}));

jest.mock('react-native-tcp-socket', () => ({
  __esModule: true,
  default: {
    createServer: jest.fn(),
  },
}));

import { DlnaController, buildDidlMetadata, buildSoapEnvelope } from '@/services/dlna/control';
import { createSsdpSearchMessage, parseSsdpResponse } from '@/services/dlna/discovery';
import { parseLastChange, resolveEventSubUrl } from '@/services/dlna/events';
import {
  hasRemotePlaybackStarted,
  isRemoteDurationReady,
  isRemotePositionAtEnd,
  isSameRemoteTrackUri,
  resolveRemoteDuration,
  shouldApplyRemotePosition,
  shouldConfirmPlaybackFromTransportState,
  shouldHandleRemoteTerminalState,
  shouldIgnoreUnconfirmedTerminalState,
} from '@/services/dlna/playback';
import type { DLNADevice } from '@/services/dlna/types';
import {
  formatMillisAsDuration,
  isDurationImplemented,
  parseDeviceDescription,
  parseDurationToMillis,
} from '@/services/dlna/xml';

const device: DLNADevice = {
  id: 'uuid:test',
  udn: 'uuid:test',
  friendlyName: '客厅电视',
  location: 'http://192.168.1.20:9197/description.xml',
  controlUrl: 'http://192.168.1.20:9197/AVTransport/control',
  serviceType: 'urn:schemas-upnp-org:service:AVTransport:1',
  address: '192.168.1.20:9197',
  renderingControlUrl: 'http://192.168.1.20:9197/RenderingControl/control',
  renderingControlServiceType: 'urn:schemas-upnp-org:service:RenderingControl:1',
  hasRenderingControlService: true,
};

describe('DLNA SSDP 与设备描述', () => {
  it('生成标准 M-SEARCH 请求', () => {
    const message = createSsdpSearchMessage('urn:schemas-upnp-org:device:MediaRenderer:1');
    expect(message).toContain('M-SEARCH * HTTP/1.1');
    expect(message).toContain('HOST: 239.255.255.250:1900');
    expect(message).toContain('MAN: "ssdp:discover"');
  });

  it('大小写不敏感地解析响应头', () => {
    const response = [
      'HTTP/1.1 200 OK',
      'Location: http://192.168.1.20:9197/description.xml',
      'USN: uuid:test::urn:schemas-upnp-org:device:MediaRenderer:1',
      '',
    ].join('\r\n');
    expect(parseSsdpResponse(response)?.headers.location).toBe(
      'http://192.168.1.20:9197/description.xml',
    );
  });

  it('从带命名空间的设备描述中找出 AVTransport 控制地址', () => {
    const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>客厅电视</friendlyName>
    <manufacturer>Sony</manufacturer>
    <modelName>BRAVIA</modelName>
    <UDN>uuid:test</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/AVTransport/control</controlURL>
        <eventSubURL>/AVTransport/event</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/RenderingControl/control</controlURL>
        <eventSubURL>/RenderingControl/event</eventSubURL>
        <SCPDURL>/RenderingControl.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`;
    const parsed = parseDeviceDescription(xml, 'http://192.168.1.20:9197/description.xml');
    expect(parsed).toMatchObject({
      id: 'uuid:test',
      friendlyName: '客厅电视',
      modelName: 'BRAVIA',
      controlUrl: 'http://192.168.1.20:9197/AVTransport/control',
      eventSubUrl: 'http://192.168.1.20:9197/AVTransport/event',
      renderingControlUrl: 'http://192.168.1.20:9197/RenderingControl/control',
      renderingControlServiceType: 'urn:schemas-upnp-org:service:RenderingControl:1',
          hasRenderingControlService: true,
    });
  });
});

describe('DLNA 事件订阅', () => {
  it('解析 LastChange 中的播放状态与时长', () => {
    const body = `<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>&lt;Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"&gt;&lt;InstanceID val="0"&gt;&lt;TransportState val="PLAYING"/&gt;&lt;CurrentTrackDuration val="00:42:21"/&gt;&lt;RelativeTimePosition val="00:01:05"/&gt;&lt;/InstanceID&gt;&lt;/Event&gt;</LastChange></e:property></e:propertyset>`;
    expect(parseLastChange(body)).toEqual({
      transportState: 'PLAYING',
      durationMillis: 2541000,
    });
  });

  it('旧设备记录缺少 eventSubURL 时按 control 同级路径推导', () => {
    expect(resolveEventSubUrl(device)).toBe('http://192.168.1.20:9197/AVTransport/event');
  });
});

describe('DLNA 时间与 SOAP', () => {
  it('解析和格式化 AVTransport 时间', () => {
    expect(parseDurationToMillis('01:02:03')).toBe(3723000);
    expect(parseDurationToMillis('0:42:21')).toBe(2541000);
    expect(parseDurationToMillis('0:00:50')).toBe(50000);
    expect(parseDurationToMillis('00:00:01.500')).toBe(1500);
    expect(formatMillisAsDuration(3723000)).toBe('01:02:03');
  });
  it('识别设备是否提供位置信息', () => {
    expect(isDurationImplemented('00:00:00')).toBe(true);
    expect(isDurationImplemented('01:02:03.500')).toBe(true);
    expect(isDurationImplemented('NOT_IMPLEMENTED')).toBe(false);
    expect(isDurationImplemented('')).toBe(false);
    expect(isDurationImplemented(undefined)).toBe(false);
  });

  it('远端时长未就绪时不允许按恢复点 Seek', () => {
    expect(isRemoteDurationReady(50_000, 211_000)).toBe(false);
    expect(isRemoteDurationReady(2_541_000, 211_000)).toBe(true);
    expect(isRemoteDurationReady(0, 0)).toBe(true);
  });

  it('用 TrackURI 排除 SetAVTransportURI 后旧媒体的时长', () => {
    expect(
      isSameRemoteTrackUri(
        'http://192.168.1.2:9000/new/index.m3u8?token=1',
        'http://192.168.1.2:9000/new/index.m3u8?token=1',
      ),
    ).toBe(true);
    expect(
      isSameRemoteTrackUri(
        'http://192.168.1.2:9000/old/index.m3u8',
        'http://192.168.1.2:9000/new/index.m3u8',
      ),
    ).toBe(false);
    expect(
      isSameRemoteTrackUri(
        '',
        'http://192.168.1.2:9000/new/index.m3u8',
      ),
    ).toBe(true);
  });

  it('识别远端终止事件是否属于正常播放结束', () => {
    expect(isRemotePositionAtEnd(49_000, 50_000)).toBe(true);
    expect(isRemotePositionAtEnd(40_000, 50_000)).toBe(false);
    expect(isRemotePositionAtEnd(0, 0)).toBe(false);
  });
  it('远端位置推进后才算真正开始播放', () => {
    expect(hasRemotePlaybackStarted(null, 0)).toBe(false);
    expect(hasRemotePlaybackStarted(0, 0)).toBe(false);
    expect(hasRemotePlaybackStarted(0, 500)).toBe(true);
    expect(hasRemotePlaybackStarted(120_000, 120_500)).toBe(true);
    expect(hasRemotePlaybackStarted(120_500, 120_000)).toBe(false);
  });
  it('标准 PLAYING 状态可直接确认播放已开始', () => {
    expect(shouldConfirmPlaybackFromTransportState('PLAYING', false)).toBe(true);
    expect(shouldConfirmPlaybackFromTransportState('TRANSITIONING', false)).toBe(false);
    expect(shouldConfirmPlaybackFromTransportState('STOPPED', false)).toBe(false);
    expect(shouldConfirmPlaybackFromTransportState('PLAYING', true)).toBe(false);
  });

  it('手机主动切换媒体时忽略远端停止事件', () => {
    expect(shouldHandleRemoteTerminalState('STOPPED', false, false)).toBe(false);
    expect(shouldHandleRemoteTerminalState('NO_MEDIA_PRESENT', false, false)).toBe(false);
    expect(shouldHandleRemoteTerminalState('STOPPED', true, true)).toBe(false);
  });

  it('播放确认前忽略终止状态，但不能忽略真实播放状态', () => {
    expect(shouldIgnoreUnconfirmedTerminalState('STOPPED', false)).toBe(true);
    expect(shouldIgnoreUnconfirmedTerminalState('NO_MEDIA_PRESENT', false)).toBe(true);
    expect(shouldIgnoreUnconfirmedTerminalState('PLAYING', false)).toBe(false);
    expect(shouldIgnoreUnconfirmedTerminalState('STOPPED', true)).toBe(false);
  });

  it('已确认播放后远端停止事件仍需处理', () => {
    expect(shouldHandleRemoteTerminalState('STOPPED', true, false)).toBe(true);
    expect(shouldHandleRemoteTerminalState('NO_MEDIA_PRESENT', true, false)).toBe(true);
    expect(shouldHandleRemoteTerminalState('PLAYING', true, false)).toBe(false);
    expect(shouldHandleRemoteTerminalState('TRANSITIONING', true, false)).toBe(false);
  });

  it('加载初期忽略 Macast 返回的过渡短时长', () => {
    expect(resolveRemoteDuration(2_541_000, 4_000, 1000, 2_541_000)).toBe(2_541_000);
    expect(resolveRemoteDuration(2_541_000, 50_000, 1000, 2_541_000)).toBe(2_541_000);
    expect(resolveRemoteDuration(2_541_000, 50_000, 16000, 2_541_000)).toBe(2_541_000);
    expect(resolveRemoteDuration(2_541_000, 2_540_000, 1000)).toBe(2_540_000);
  });


  it('位置回到 0 时按传输状态区分"用户拖回开头"与"被控端重置"', () => {
    // Macast 实测：拖动到最开头后状态仍是 PLAYING，这个 0 必须接受。
    expect(shouldApplyRemotePosition(91_000, 0, 'PLAYING')).toBe(true);
    expect(shouldApplyRemotePosition(91_000, 0, 'PAUSED_PLAYBACK')).toBe(true);
    // EOF/停止时状态是停止/无媒体，属于重置，必须保留最后进度。
    expect(shouldApplyRemotePosition(91_000, 0, 'STOPPED')).toBe(false);
    expect(shouldApplyRemotePosition(91_000, 0, 'NO_MEDIA_PRESENT')).toBe(false);
    // 状态查不到时按重置处理，宁可不更新也不要把进度弄丢。
    expect(shouldApplyRemotePosition(91_000, 0, 'UNKNOWN')).toBe(false);
    // 本来就没有已知进度、或位置是正数时，正常接受。
    expect(shouldApplyRemotePosition(0, 0, 'STOPPED')).toBe(true);
    expect(shouldApplyRemotePosition(91_000, 45_000, 'STOPPED')).toBe(true);
  });

  it('构造转义后的 SetAVTransportURI SOAP 请求', () => {
    const didl = buildDidlMetadata(
      'http://192.168.1.2:9000/a.m3u8?x=1&y=2',
      '示例剧 第2集',
      undefined,
      'https://img.example.com/cover.jpg?x=1&y=2',
    );
    expect(didl).toContain('protocolInfo="http-get:*:video/m3u8:*"');
    expect(didl).toContain('<dc:title>示例剧 第2集</dc:title>');
    expect(didl).toContain('<upnp:albumArtURI>https://img.example.com/cover.jpg?x=1&amp;y=2</upnp:albumArtURI>');
    const envelope = buildSoapEnvelope(
      'urn:schemas-upnp-org:service:AVTransport:1',
      'SetAVTransportURI',
      {
        InstanceID: 0,
        CurrentURI: 'http://192.168.1.2:9000/a.m3u8?x=1&y=2',
        CurrentURIMetaData: didl,
      },
    );
    expect(envelope).toContain('<u:SetAVTransportURI');
    expect(envelope).toContain('xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"');
    expect(envelope).toContain('http://192.168.1.2:9000/a.m3u8?x=1&amp;y=2');
    expect(envelope).toContain('&lt;DIDL-Lite');
  });

  it('调用 Play 时发送 SOAPAction', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>',
    }));
    global.fetch = fetchMock as any;
    await new DlnaController(device).play();
    expect(fetchMock).toHaveBeenCalledWith(
      device.controlUrl,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#Play"',
        }),
      }),
    );
  });
});


describe('DLNA RenderingControl', () => {
  it('按标准动作调用音量和亮度', async () => {
    const fetchMock = jest.fn(async (_url: string, init?: any) => {
      const soapAction = String(init?.headers?.SOAPAction ?? '');
      let body = '';
      if (soapAction.includes('#GetVolume')) {
        body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><CurrentVolume>42</CurrentVolume></u:GetVolumeResponse></s:Body></s:Envelope>';
      } else if (soapAction.includes('#SetVolume')) {
        body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:SetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"/></s:Body></s:Envelope>';
      } else if (soapAction.includes('#GetBrightness')) {
        body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetBrightnessResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><CurrentBrightness>37</CurrentBrightness></u:GetBrightnessResponse></s:Body></s:Envelope>';
      } else {
        body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:SetBrightnessResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"/></s:Body></s:Envelope>';
      }
      return { ok: true, status: 200, text: async () => body };
    });
    global.fetch = fetchMock as any;

    const controller = new DlnaController(device);
    await expect(controller.getVolume()).resolves.toBe(42);
    await controller.setVolume(25);
    await expect(controller.getBrightness()).resolves.toBe(37);
    await controller.setBrightness(60);

    const calls = fetchMock.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      device.renderingControlUrl,
      device.renderingControlUrl,
      device.renderingControlUrl,
      device.renderingControlUrl,
    ]);
    expect(calls.map(([, init]) => (init as any).headers.SOAPAction)).toEqual([
      '"urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"',
      '"urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"',
      '"urn:schemas-upnp-org:service:RenderingControl:1#GetBrightness"',
      '"urn:schemas-upnp-org:service:RenderingControl:1#SetBrightness"',
    ]);
    expect((calls[1][1] as any).body).toContain('<DesiredVolume>25</DesiredVolume>');
    expect((calls[3][1] as any).body).toContain('<DesiredBrightness>60</DesiredBrightness>');
  });

});

describe('DLNA 倍速', () => {
  it('按标准 Play(Speed) 原样下发软件内置倍率', async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: any) => ({
      ok: true,
      status: 200,
      text: async () =>
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>',
    }));
    global.fetch = fetchMock as any;

    const controller = new DlnaController(device);
    await controller.play('1.5');
    await controller.play('0.5');

    const bodies = fetchMock.mock.calls.map(([, init]) => (init as any).body as string);
    expect(bodies[0]).toContain('<Speed>1.5</Speed>');
    expect(bodies[1]).toContain('<Speed>0.5</Speed>');
    expect(fetchMock).toHaveBeenCalledWith(
      device.controlUrl,
      expect.objectContaining({
        headers: expect.objectContaining({
          SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#Play"',
        }),
      }),
    );
  });
});
