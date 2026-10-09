import useAccountStore, { selectCurrentAccount, selectServerAccounts } from '@/stores/accountStore';
import useAuthStore from '@/stores/authStore';
import { api } from '@/services/api';
import { AccountManager, LoginCredentialsManager, SavedAccount } from '@/services/storage';
import Toast from '@/utils/Toast';
import { ACCOUNT_COLORS } from '@/constants/AccountColors';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('@/services/api', () => ({
  api: {
    login: jest.fn(),
    logout: jest.fn(),
  },
}));

jest.mock('@/services/storage', () => ({
  AccountManager: {
    get: jest.fn(),
    save: jest.fn(async () => undefined),
  },
  LoginCredentialsManager: {
    get: jest.fn(async () => null),
    save: jest.fn(async () => undefined),
  },
}));

const mockSettings = { apiBaseUrl: 'http://server-a' };
jest.mock('@/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => mockSettings },
}));

const mockRefreshPlayRecords = jest.fn(async () => undefined);
jest.mock('@/stores/homeStore', () => ({
  __esModule: true,
  default: { getState: () => ({ refreshPlayRecords: mockRefreshPlayRecords }) },
}));

jest.mock('@/utils/Toast', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

const mockApi = api as unknown as { login: jest.Mock; logout: jest.Mock };
const mockAccountManager = AccountManager as unknown as { get: jest.Mock; save: jest.Mock };
const mockCredentials = LoginCredentialsManager as unknown as { get: jest.Mock; save: jest.Mock };
const mockToast = Toast as unknown as { show: jest.Mock };

const initialAccountState = useAccountStore.getState();
const initialAuthState = useAuthStore.getState();

const makeAccount = (username: string, overrides: Partial<SavedAccount> = {}): SavedAccount => ({
  id: `http://server-a::${username}`,
  serverUrl: 'http://server-a',
  username,
  password: `${username}-pw`,
  color: ACCOUNT_COLORS[0].bg,
  lastUsedAt: 1000,
  ...overrides,
});

const unauthorized = () => new Error('UNAUTHORIZED');

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings.apiBaseUrl = 'http://server-a';
  mockApi.login.mockResolvedValue({ ok: true });
  mockApi.logout.mockResolvedValue({ ok: true });
  mockCredentials.get.mockResolvedValue(null);
  useAccountStore.setState(initialAccountState, true);
  useAccountStore.setState({ enabled: true, loaded: true });
  useAuthStore.setState(initialAuthState, true);
});

describe('accountStore.recordLogin', () => {
  it('登录的账号成为当前账号并持久化', async () => {
    const account = await useAccountStore.getState().recordLogin('alice', 'a-pw');

    const state = useAccountStore.getState();
    expect(account.id).toBe('http://server-a::alice');
    expect(state.currentId).toBe(account.id);
    expect(mockAccountManager.save).toHaveBeenCalledWith({ accounts: state.accounts, currentId: account.id });
  });

  it('新账号使用未被占用的颜色，并成为当前账号', async () => {
    const first = await useAccountStore.getState().recordLogin('alice', 'a-pw');
    const second = await useAccountStore.getState().recordLogin('bob', 'b-pw');

    expect(second.color).not.toBe(first.color);
    expect(useAccountStore.getState().currentId).toBe(second.id);
  });

  it('同一用户再次登录时更新密码并清除失效标记，不重复添加', async () => {
    useAccountStore.setState({ accounts: [makeAccount('alice', { needsReauth: true, password: 'old' })] });

    await useAccountStore.getState().recordLogin('alice', 'new-pw');

    const { accounts } = useAccountStore.getState();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].password).toBe('new-pw');
    expect(accounts[0].needsReauth).toBe(false);
  });
});

describe('accountStore 服务器隔离', () => {
  it('只返回当前服务器的账号', () => {
    const other = makeAccount('carol', { id: 'http://server-b::carol', serverUrl: 'http://server-b' });
    useAccountStore.setState({ accounts: [makeAccount('alice'), other], currentId: other.id });

    const state = useAccountStore.getState();
    expect(selectServerAccounts(state).map((a) => a.username)).toEqual(['alice']);
    expect(selectCurrentAccount(state)).toBeNull();
  });
});

describe('accountStore.switchTo', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [makeAccount('alice'), makeAccount('bob')],
      currentId: 'http://server-a::alice',
    });
    useAuthStore.setState({ isLoggedIn: true });
  });

  it('用保存的密码登录目标账号并刷新播放记录', async () => {
    await useAccountStore.getState().switchTo('http://server-a::bob');

    const state = useAccountStore.getState();
    expect(mockApi.login).toHaveBeenCalledWith('bob', 'bob-pw');
    expect(state.currentId).toBe('http://server-a::bob');
    expect(state.switchingTo).toBeNull();
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(mockCredentials.save).toHaveBeenCalledWith({ username: 'bob', password: 'bob-pw' });
    expect(mockRefreshPlayRecords).toHaveBeenCalled();
    expect(mockToast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('选择当前账号时只关闭选择页，不重新登录', async () => {
    useAccountStore.setState({ isPickerVisible: true });

    await useAccountStore.getState().switchTo('http://server-a::alice');

    expect(mockApi.login).not.toHaveBeenCalled();
    expect(useAccountStore.getState().isPickerVisible).toBe(false);
  });

  it('密码被服务器拒绝时标记失效并打开重新登录表单，当前账号不变', async () => {
    mockApi.login.mockRejectedValue(unauthorized());

    await useAccountStore.getState().switchTo('http://server-a::bob');

    const state = useAccountStore.getState();
    expect(state.currentId).toBe('http://server-a::alice');
    expect(state.accounts.find((a) => a.username === 'bob')?.needsReauth).toBe(true);
    expect(state.form).toEqual({ mode: 'reauth', accountId: 'http://server-a::bob' });
  });

  it('网络错误时提示失败，不打开表单', async () => {
    mockApi.login.mockRejectedValue(new Error('Network request failed'));

    await useAccountStore.getState().switchTo('http://server-a::bob');

    const state = useAccountStore.getState();
    expect(state.currentId).toBe('http://server-a::alice');
    expect(state.form).toBeNull();
    expect(mockToast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('已登出的账号直接打开重新登录表单，不发起登录', async () => {
    useAccountStore.setState({
      accounts: [makeAccount('alice'), makeAccount('bob', { password: undefined })],
    });

    await useAccountStore.getState().switchTo('http://server-a::bob');

    expect(mockApi.login).not.toHaveBeenCalled();
    expect(useAccountStore.getState().form).toEqual({ mode: 'reauth', accountId: 'http://server-a::bob' });
  });
});

describe('accountStore.logoutAccount / removeAccount', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [makeAccount('alice'), makeAccount('bob')],
      currentId: 'http://server-a::alice',
    });
    useAuthStore.setState({ isLoggedIn: true });
  });

  it('登出当前账号：清除密码并显示选择页', async () => {
    await useAccountStore.getState().logoutAccount('http://server-a::alice');

    const state = useAccountStore.getState();
    expect(mockApi.logout).toHaveBeenCalled();
    expect(state.currentId).toBeNull();
    expect(state.accounts.find((a) => a.username === 'alice')?.password).toBeUndefined();
    expect(state.isPickerVisible).toBe(true);
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
    expect(mockCredentials.save).toHaveBeenCalledWith({ username: 'alice', password: '' });
  });

  it('登出非当前账号只清除它的密码，不影响当前登录', async () => {
    await useAccountStore.getState().logoutAccount('http://server-a::bob');

    const state = useAccountStore.getState();
    expect(mockApi.logout).not.toHaveBeenCalled();
    expect(state.currentId).toBe('http://server-a::alice');
    expect(state.accounts.find((a) => a.username === 'bob')?.password).toBeUndefined();
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });

  it('删除其他账号不影响当前登录', async () => {
    await useAccountStore.getState().removeAccount('http://server-a::bob');

    const state = useAccountStore.getState();
    expect(state.accounts.map((a) => a.username)).toEqual(['alice']);
    expect(state.currentId).toBe('http://server-a::alice');
    expect(mockApi.logout).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });

  it('移除最后一个账号后打开登录表单，不再弹出旧登录弹窗', async () => {
    useAccountStore.setState({ accounts: [makeAccount('alice')] });

    await useAccountStore.getState().removeAccount('http://server-a::alice');

    expect(useAccountStore.getState().accounts).toHaveLength(0);
    expect(useAccountStore.getState().isPickerVisible).toBe(false);
    expect(useAccountStore.getState().form).toEqual({ mode: 'add' });
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
  });
});

describe('accountStore.handleLaunch', () => {
  beforeEach(() => {
    useAuthStore.setState({ isLoggedIn: true });
  });

  it('有多个账号时直接进入上次使用的账号，不显示选择页也不重新登录', async () => {
    useAccountStore.setState({
      accounts: [makeAccount('alice'), makeAccount('bob')],
      currentId: 'http://server-a::bob',
    });

    await useAccountStore.getState().handleLaunch();

    const state = useAccountStore.getState();
    expect(state.isPickerVisible).toBe(false);
    expect(state.currentId).toBe('http://server-a::bob');
    expect(mockApi.login).not.toHaveBeenCalled();
  });

  it('把旧版本保存的单份凭据补记为当前账号', async () => {
    mockCredentials.get.mockResolvedValue({ username: 'alice', password: 'a-pw' });

    await useAccountStore.getState().handleLaunch();

    const state = useAccountStore.getState();
    expect(state.accounts).toHaveLength(1);
    expect(state.currentId).toBe('http://server-a::alice');
    expect(mockApi.login).not.toHaveBeenCalled();
  });

  it('未启用多账号时不做任何处理', async () => {
    useAccountStore.setState({
      enabled: false,
      accounts: [makeAccount('alice'), makeAccount('bob')],
      currentId: 'http://server-a::alice',
    });

    await useAccountStore.getState().handleLaunch();

    expect(useAccountStore.getState().isPickerVisible).toBe(false);
  });
});

describe('accountStore.handleLoginRequired', () => {
  beforeEach(() => {
    useAuthStore.setState({ isLoggedIn: false, isLoginModalVisible: true });
  });

  it('登录失效时先用保存的密码静默重登', async () => {
    useAccountStore.setState({ accounts: [makeAccount('alice')], currentId: 'http://server-a::alice' });

    await useAccountStore.getState().handleLoginRequired();

    expect(mockApi.login).toHaveBeenCalledWith('alice', 'alice-pw');
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
    expect(useAccountStore.getState().isRecovering).toBe(false);
  });

  it('静默重登被拒绝时打开该账号的重新登录表单', async () => {
    mockApi.login.mockRejectedValue(unauthorized());
    useAccountStore.setState({ accounts: [makeAccount('alice')], currentId: 'http://server-a::alice' });

    await useAccountStore.getState().handleLoginRequired();

    const state = useAccountStore.getState();
    expect(state.form).toEqual({ mode: 'reauth', accountId: 'http://server-a::alice' });
    expect(state.accounts[0].needsReauth).toBe(true);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
  });

  it('静默重登遇到网络错误时提示失败并显示选择页', async () => {
    mockApi.login.mockRejectedValue(new Error('Network request failed'));
    useAccountStore.setState({
      accounts: [makeAccount('alice'), makeAccount('bob')],
      currentId: 'http://server-a::alice',
    });

    await useAccountStore.getState().handleLoginRequired();

    expect(mockToast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(useAccountStore.getState().isPickerVisible).toBe(true);
    expect(useAccountStore.getState().form).toBeNull();
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
  });

  it('没有当前账号但有保存的账号时显示选择页', async () => {
    useAccountStore.setState({ accounts: [makeAccount('alice', { password: undefined })], currentId: null });

    await useAccountStore.getState().handleLoginRequired();

    expect(mockApi.login).not.toHaveBeenCalled();
    expect(useAccountStore.getState().isPickerVisible).toBe(true);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
  });

  it('首次登录（本机没有账号）时打开新的登录表单', async () => {
    await useAccountStore.getState().handleLoginRequired();

    expect(useAccountStore.getState().isPickerVisible).toBe(false);
    expect(useAccountStore.getState().form).toEqual({ mode: 'add' });
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
  });
});

describe('accountStore.addAccount / reauth', () => {
  it('添加账号：登录成功后保存并切换，关闭表单', async () => {
    useAuthStore.setState({ isLoggedIn: true });
    useAccountStore.setState({ form: { mode: 'add' } });

    await useAccountStore.getState().addAccount('dave', 'd-pw', ACCOUNT_COLORS[3].bg);

    const state = useAccountStore.getState();
    expect(mockApi.login).toHaveBeenCalledWith('dave', 'd-pw');
    expect(state.currentId).toBe('http://server-a::dave');
    expect(state.accounts[0].color).toBe(ACCOUNT_COLORS[3].bg);
    expect(state.form).toBeNull();
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });

  it('添加账号失败时抛出错误且不保存账号', async () => {
    mockApi.login.mockRejectedValue(unauthorized());
    useAccountStore.setState({ form: { mode: 'add' } });

    await expect(useAccountStore.getState().addAccount('dave', 'bad', ACCOUNT_COLORS[0].bg)).rejects.toThrow(
      'UNAUTHORIZED'
    );

    expect(useAccountStore.getState().accounts).toHaveLength(0);
    expect(useAccountStore.getState().form).toEqual({ mode: 'add' });
  });

  it('重新登录：更新密码并清除失效标记', async () => {
    useAccountStore.setState({
      accounts: [makeAccount('alice', { needsReauth: true })],
      form: { mode: 'reauth', accountId: 'http://server-a::alice' },
    });

    await useAccountStore.getState().reauth('http://server-a::alice', 'fresh-pw');

    const [account] = useAccountStore.getState().accounts;
    expect(mockApi.login).toHaveBeenCalledWith('alice', 'fresh-pw');
    expect(account.password).toBe('fresh-pw');
    expect(account.needsReauth).toBe(false);
    expect(useAccountStore.getState().form).toBeNull();
  });
});

describe('accountStore 首次登录与取消', () => {
  it('首次登录成功提示「登录成功」而不是「已切换」', async () => {
    useAccountStore.setState({ form: { mode: 'add' } });

    await useAccountStore.getState().addAccount('alice', 'a-pw', ACCOUNT_COLORS[0].bg);

    expect(mockToast.show).toHaveBeenCalledWith(expect.objectContaining({ text1: '登录成功' }));
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });

  it('首次登录时取消：直接关闭，可以先去设置里改服务器地址', () => {
    useAccountStore.setState({ form: { mode: 'add' } });

    useAccountStore.getState().closeForm();

    expect(useAccountStore.getState().form).toBeNull();
    expect(useAccountStore.getState().isPickerVisible).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
  });

  it('未登录且有保存账号时取消表单：回到选择页', () => {
    useAccountStore.setState({ accounts: [makeAccount('alice')], form: { mode: 'add' } });

    useAccountStore.getState().closeForm();

    expect(useAccountStore.getState().isPickerVisible).toBe(true);
  });
});

describe('accountStore 未启用多账号（localstorage 服务器）', () => {
  it('localstorage 服务器（未接管登录）时登出走原来的逻辑', async () => {
    useAccountStore.setState({
      enabled: false,
      accounts: [makeAccount('alice')],
      currentId: 'http://server-a::alice',
    });
    useAuthStore.setState({ isLoggedIn: true });

    await useAccountStore.getState().logoutCurrent();

    expect(mockApi.logout).toHaveBeenCalled();
    expect(useAccountStore.getState().form).toBeNull();
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });
});
