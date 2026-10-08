import { buildPlaybackTitle } from '@/utils/PlaybackTitleUtils';

describe('播放标题文本', () => {
  it('剧集标题与手机左上角保持一致', () => {
    expect(buildPlaybackTitle({
      title: '示例剧',
      episodeCount: 12,
      episodeTitle: '第01集',
      sourceName: '猫眼资源',
    })).toBe('示例剧 - 第01集 (猫眼资源)');
  });

  it('电影标题不拼接集名', () => {
    expect(buildPlaybackTitle({
      title: '示例电影',
      episodeCount: 1,
      episodeTitle: '正片',
      sourceName: '直连源',
    })).toBe('示例电影 (直连源)');
  });

  it('标题不包含代理图标等额外内容', () => {
    expect(buildPlaybackTitle({
      title: '示例',
      episodeCount: 1,
      sourceName: '源',
    })).toBe('示例 (源)');
  });
});
