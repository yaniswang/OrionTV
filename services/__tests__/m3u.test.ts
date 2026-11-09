import { parseM3UPlaylist } from '../m3u';

const HEADER = '#EXTM3U x-tvg-url="https://a/playback.xml" catchup="append" catchup-source="?playbackbegin=${(b)yyyyMMddHHmmss}&playbackend=${(e)yyyyMMddHHmmss}"';

describe('parseM3UPlaylist', () => {
  it('解析头部的回放参数和频道的 tvg-id / tvg-name', () => {
    const text = [
      HEADER,
      '#EXTINF:-1 tvg-id="CCTV1综合" tvg-name="CCTV1综合" tvg-logo="https://a/1.webp" group-title="央视",CCTV1综合',
      'https://a/u/608807420',
    ].join('\n');
    const { channels } = parseM3UPlaylist(text);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      name: 'CCTV1综合', tvgId: 'CCTV1综合', tvgName: 'CCTV1综合', group: '央视', url: 'https://a/u/608807420',
    });
    expect(channels[0].catchup).toMatchObject({
      mode: 'append',
      source: '?playbackbegin=${(b)yyyyMMddHHmmss}&playbackend=${(e)yyyyMMddHHmmss}',
    });
  });

  it('频道行自带的 catchup-source 优先于头部', () => {
    const text = [
      HEADER,
      '#EXTINF:-1 tvg-id="x" catchup="default" catchup-source="https://b/x?s=${(b)yyyyMMddHHmmss}",X',
      'https://a/x',
    ].join('\n');
    expect(parseM3UPlaylist(text).channels[0].catchup).toEqual({ mode: 'default', source: 'https://b/x?s=${(b)yyyyMMddHHmmss}' });
  });

  it('没有回放参数时 catchup 为空', () => {
    const text = ['#EXTM3U', '#EXTINF:-1 group-title="卫视",东方卫视', 'https://a/dongfang'].join('\n');
    const ch = parseM3UPlaylist(text).channels[0];
    expect(ch.catchup).toBeUndefined();
    expect(ch.tvgId).toBe('');
  });

  it('频道行 catchup="none" 关掉文件头的回看（服务端用它标记不支持回看的频道）', () => {
    const text = [
      HEADER,
      '#EXTINF:-1 tvg-id="格尔木" group-title="青海" catchup="none",格尔木新闻综合',
      'https://a/proxy/x.m3u8',
      '#EXTINF:-1 tvg-id="CCTV1综合" group-title="央视",CCTV1综合',
      'https://a/u/608807420',
    ].join('\n');
    const { channels } = parseM3UPlaylist(text);
    expect(channels[0].catchup).toBeUndefined();
    expect(channels[1].catchup).toEqual({ mode: 'append', source: '?playbackbegin=${(b)yyyyMMddHHmmss}&playbackend=${(e)yyyyMMddHHmmss}' });
  });

  it('频道行只写模式没写模板时，模板继承文件头', () => {
    const text = [HEADER, '#EXTINF:-1 catchup="append",X', 'https://a/x'].join('\n');
    expect(parseM3UPlaylist(text).channels[0].catchup).toEqual({
      mode: 'append',
      source: '?playbackbegin=${(b)yyyyMMddHHmmss}&playbackend=${(e)yyyyMMddHHmmss}',
    });
  });

  it('catchup-days：频道行优先，其次文件头，都没写为空', () => {
    const text = [
      '#EXTM3U catchup="append" catchup-days="3" catchup-source="?b=${(b)yyyyMMddHHmmss}"',
      '#EXTINF:-1 catchup-days="7",A',
      'https://a/a',
      '#EXTINF:-1,B',
      'https://a/b',
    ].join('\n');
    const { channels } = parseM3UPlaylist(text);
    expect(channels[0].catchup?.days).toBe(7);
    expect(channels[1].catchup?.days).toBe(3);
    expect(parseM3UPlaylist([HEADER, '#EXTINF:-1,C', 'https://a/c'].join('\n')).channels[0].catchup?.days).toBeUndefined();
  });

  it('catchup-days 不是正整数时忽略', () => {
    const text = [HEADER, '#EXTINF:-1 catchup-days="x",A', 'https://a/a'].join('\n');
    expect(parseM3UPlaylist(text).channels[0].catchup?.days).toBeUndefined();
  });

  it('不认识的 catchup 模式当作不支持回看', () => {
    const text = ['#EXTM3U catchup="shift" catchup-source="?utc={utc}"', '#EXTINF:-1,X', 'https://a/x'].join('\n');
    expect(parseM3UPlaylist(text).channels[0].catchup).toBeUndefined();
  });
});
