import TcpSocket from 'react-native-tcp-socket';
import NetInfo from '@react-native-community/netinfo';
import Logger from '@/utils/Logger';

const logger = Logger.withTag('TCPHttpServer');

const PORT = 12346;
/** 端口被占用时最多顺着往后试几个端口（热重载不会释放上一次 JS 上下文的监听） */
const PORT_ATTEMPTS = 5;

/** 判断是否为"端口已被占用"，只有这种情况才值得换端口重试 */
function isAddressInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRINUSE|address already in use/i.test(message);
}

interface HttpRequest {
  method: string;
  url: string;
  headers: { [key: string]: string };
  body: string;
}

interface HttpResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

type RequestHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

class TCPHttpServer {
  private server: TcpSocket.Server | null = null;
  private isRunning = false;
  private requestHandler: RequestHandler | null = null;
  /** 正在进行的启动：并发调用 start 时复用同一次，避免同时建两个监听 */
  private pendingStart: Promise<string> | null = null;
  /** 实际监听成功的地址（端口被占用时会顺延，不能再按常量 PORT 拼） */
  private boundUrl: string | null = null;

  constructor() {
    this.server = null;
  }

  private parseHttpRequest(data: string): HttpRequest | null {
    try {
      const lines = data.split('\r\n');
      const requestLine = lines[0].split(' ');
      
      if (requestLine.length < 3) {
        return null;
      }

      const method = requestLine[0];
      const url = requestLine[1];
      const headers: { [key: string]: string } = {};
      
      let bodyStartIndex = -1;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') {
          bodyStartIndex = i + 1;
          break;
        }
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line.substring(colonIndex + 1).trim();
          headers[key] = value;
        }
      }

      const body = bodyStartIndex > 0 ? lines.slice(bodyStartIndex).join('\r\n') : '';

      return { method, url, headers, body };
    } catch (error) {
      logger.info('[TCPHttpServer] Error parsing HTTP request:', error);
      return null;
    }
  }

  private formatHttpResponse(response: HttpResponse): string {
    const statusTexts: { [key: number]: string } = {
      200: 'OK',
      400: 'Bad Request',
      404: 'Not Found',
      500: 'Internal Server Error'
    };

    const statusText = statusTexts[response.statusCode] || 'Unknown';
    const headers = {
      'Content-Length': new TextEncoder().encode(response.body).length.toString(),
      'Connection': 'close',
      ...response.headers
    };

    let httpResponse = `HTTP/1.1 ${response.statusCode} ${statusText}\r\n`;
    
    for (const [key, value] of Object.entries(headers)) {
      httpResponse += `${key}: ${value}\r\n`;
    }
    
    httpResponse += '\r\n';
    httpResponse += response.body;

    return httpResponse;
  }

  public setRequestHandler(handler: RequestHandler) {
    this.requestHandler = handler;
  }

  public start(): Promise<string> {
    if (this.pendingStart) {
      logger.debug('[TCPHttpServer] Start already in progress.');
      return this.pendingStart;
    }
    const task = this.doStart().finally(() => {
      if (this.pendingStart === task) {
        this.pendingStart = null;
      }
    });
    this.pendingStart = task;
    return task;
  }

  private async doStart(): Promise<string> {
    const netState = await NetInfo.fetch();
    let ipAddress: string | null = null;
    
    if (netState.type === 'wifi' || netState.type === 'ethernet') {
      ipAddress = (netState.details as any)?.ipAddress ?? null;
    }

    if (!ipAddress) {
      throw new Error('无法获取IP地址，请确认设备已连接到WiFi或以太网。');
    }

    if (this.isRunning) {
      logger.debug('[TCPHttpServer] Server is already running.');
      return this.boundUrl ?? `http://${ipAddress}:${PORT}`;
    }

    // 上一次启动失败（或刚 stop 过）可能还留着 server 对象，先清掉再重来
    this.closeCurrentServer();

    let lastError: unknown = null;
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const port = PORT + i;
      try {
        return await this.listen(port, ipAddress);
      } catch (error) {
        lastError = error;
        if (!isAddressInUse(error)) {
          throw error;
        }
        logger.info(`[TCPHttpServer] 端口 ${port} 已被占用，换下一个端口重试`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('端口被占用，启动失败');
  }

  private listen(port: number, ipAddress: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        this.server = TcpSocket.createServer((socket: TcpSocket.Socket) => {
          logger.debug('[TCPHttpServer] Client connected');
          
          let requestData = '';
          
          socket.on('data', async (data: string | Buffer) => {
            requestData += data.toString();
            
            // Check if we have a complete HTTP request
            if (requestData.includes('\r\n\r\n')) {
              try {
                const request = this.parseHttpRequest(requestData);
                if (request && this.requestHandler) {
                  const response = await this.requestHandler(request);
                  const httpResponse = this.formatHttpResponse(response);
                  socket.write(httpResponse);
                } else {
                  // Send 400 Bad Request for malformed requests
                  const errorResponse = this.formatHttpResponse({
                    statusCode: 400,
                    headers: { 'Content-Type': 'text/plain' },
                    body: 'Bad Request'
                  });
                  socket.write(errorResponse);
                }
              } catch (error) {
                logger.info('[TCPHttpServer] Error handling request:', error);
                const errorResponse = this.formatHttpResponse({
                  statusCode: 500,
                  headers: { 'Content-Type': 'text/plain' },
                  body: 'Internal Server Error'
                });
                socket.write(errorResponse);
              }
              
              socket.end();
              requestData = '';
            }
          });

          socket.on('error', (error: Error) => {
            logger.info('[TCPHttpServer] Socket error:', error);
          });

          socket.on('close', () => {
            logger.debug('[TCPHttpServer] Client disconnected');
          });
        });

        this.server.listen({ port, host: '0.0.0.0' }, () => {
          logger.debug(`[TCPHttpServer] Server listening on ${ipAddress}:${port}`);
          this.isRunning = true;
          this.boundUrl = `http://${ipAddress}:${port}`;
          resolve(this.boundUrl);
        });

        this.server.on('error', (error: Error) => {
          logger.info('[TCPHttpServer] Server error:', error);
          this.closeCurrentServer();
          reject(error);
        });

      } catch (error) {
        logger.info('[TCPHttpServer] Failed to start server:', error);
        this.closeCurrentServer();
        reject(error);
      }
    });
  }

  public stop() {
    if (!this.server) return;
    this.closeCurrentServer();
    logger.debug('[TCPHttpServer] Server stopped');
  }

  /** 关掉当前持有的 server（启动失败时也要关，否则失败留下的 socket 会一直挂着） */
  private closeCurrentServer() {
    const server = this.server;
    this.server = null;
    this.isRunning = false;
    this.boundUrl = null;
    if (!server) return;
    try {
      server.close();
    } catch (error) {
      logger.debug('[TCPHttpServer] Close server failed:', error);
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }
}

export default TCPHttpServer;
