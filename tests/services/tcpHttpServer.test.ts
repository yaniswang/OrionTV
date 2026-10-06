import TCPHttpServer from '@/services/tcpHttpServer';
import NetInfo from '@react-native-community/netinfo';
import TcpSocket from 'react-native-tcp-socket';

jest.mock('react-native-tcp-socket', () => ({
  __esModule: true,
  default: { createServer: jest.fn() },
}));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: jest.fn() },
}));

const mockCreateServer = TcpSocket.createServer as unknown as jest.Mock;
const mockFetch = NetInfo.fetch as unknown as jest.Mock;

/**
 * 假的 TcpSocket server：
 * - error 为空时 listen 成功
 * - 否则 listen 之后抛出这个错误（模拟 bind failed: EADDRINUSE）
 */
const createFakeServer = (error?: Error) => {
  const handlers: { [event: string]: ((...args: any[]) => void)[] } = {};
  const server = {
    listen: jest.fn((_options: any, callback: () => void) => {
      if (!error) {
        setTimeout(callback, 0);
        return;
      }
      setTimeout(() => {
        (handlers.error || []).forEach((handler) => handler(error));
      }, 0);
    }),
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      handlers[event] = [...(handlers[event] || []), handler];
    }),
    close: jest.fn(),
  };
  return server;
};

const addressInUseError = () => new Error('bind failed: EADDRINUSE (Address already in use)');

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({ type: 'wifi', details: { ipAddress: '192.168.1.7' } });
});

describe('TCPHttpServer.start', () => {
  it('端口被占用时顺延到下一个端口，并关掉失败的 server', async () => {
    const busy = createFakeServer(addressInUseError());
    const free = createFakeServer();
    mockCreateServer.mockReturnValueOnce(busy).mockReturnValueOnce(free);

    const server = new TCPHttpServer();
    const url = await server.start();

    expect(url).toBe('http://192.168.1.7:12347');
    expect(busy.close).toHaveBeenCalled();
    expect(free.listen).toHaveBeenCalledWith(
      { port: 12347, host: '0.0.0.0' },
      expect.any(Function),
    );
    expect(server.getIsRunning()).toBe(true);
  });

  it('已经在运行时直接返回地址，不再新建 server', async () => {
    mockCreateServer.mockReturnValue(createFakeServer());

    const server = new TCPHttpServer();
    const first = await server.start();
    const second = await server.start();

    expect(first).toBe('http://192.168.1.7:12346');
    expect(second).toBe(first);
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
  });

  it('并发调用 start 只创建一次监听', async () => {
    mockCreateServer.mockReturnValue(createFakeServer());

    const server = new TCPHttpServer();
    const [first, second] = await Promise.all([server.start(), server.start()]);

    expect(first).toBe(second);
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
  });

  it('端口顺延后，重复 start 返回真实地址而不是默认端口', async () => {
    mockCreateServer
      .mockReturnValueOnce(createFakeServer(addressInUseError()))
      .mockReturnValue(createFakeServer());

    const server = new TCPHttpServer();
    const url = await server.start();
    expect(url).toBe('http://192.168.1.7:12347');

    await expect(server.start()).resolves.toBe('http://192.168.1.7:12347');
    expect(mockCreateServer).toHaveBeenCalledTimes(2);
  });

  it('非端口占用的错误直接抛出，不做无意义的重试', async () => {
    mockCreateServer.mockReturnValue(createFakeServer(new Error('bind failed: EACCES')));

    const server = new TCPHttpServer();
    await expect(server.start()).rejects.toThrow('EACCES');
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    expect(server.getIsRunning()).toBe(false);
  });

  it('拿不到 IP 地址时直接报错', async () => {
    mockFetch.mockResolvedValue({ type: 'none', details: {} });

    const server = new TCPHttpServer();
    await expect(server.start()).rejects.toThrow('无法获取IP地址');
    expect(mockCreateServer).not.toHaveBeenCalled();
  });

  it('stop 之后可以重新启动', async () => {
    const first = createFakeServer();
    const second = createFakeServer();
    mockCreateServer.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const server = new TCPHttpServer();
    await server.start();
    server.stop();
    expect(first.close).toHaveBeenCalled();
    expect(server.getIsRunning()).toBe(false);

    const url = await server.start();
    expect(url).toBe('http://192.168.1.7:12346');
    expect(mockCreateServer).toHaveBeenCalledTimes(2);
  });
});
