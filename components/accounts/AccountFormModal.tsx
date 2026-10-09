import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  useTVEventHandler,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import { usePathname } from "expo-router";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import useAccountStore, { selectServerAccounts } from "@/stores/accountStore";
import { useRemoteControlStore } from "@/stores/remoteControlStore";
import { useSettingsStore } from "@/stores/settingsStore";
import useAuthStore from "@/stores/authStore";
import { LoginCredentialsManager } from "@/services/storage";
import { ACCOUNT_COLORS, pickAccountColor } from "@/constants/AccountColors";
import { Colors } from "@/constants/Colors";
import { StyledButton } from "@/components/StyledButton";
import Toast, { ModalToastRoot } from "@/utils/Toast";
import { AccountAvatar } from "./AccountAvatar";

const REMOTE_TARGET = "account";

type Field = "username" | "password" | "confirm";

const FIELD_LABELS: Record<Field, string> = { username: "用户名", password: "密码", confirm: "确认新密码" };

interface FormInputProps extends TextInputProps {
  isActive: boolean;
  hasError?: boolean;
  onActivate: () => void;
  preferredFocus?: boolean;
}

/**
 * TV 遥控器选不中弹窗里的裸 TextInput：外层用可聚焦的 Pressable 接住焦点，
 * 按 OK 时再把焦点交给输入框弹出键盘（与设置页输入框的做法一致）。
 * TV 上必须在遥控器 select 事件里交接焦点；在 onPress 里调用 focus() 焦点会留在外层，输入法不会弹出。
 */
const FormInput = forwardRef<TextInput, FormInputProps>(
  ({ isActive, hasError, onActivate, preferredFocus, onFocus, ...inputProps }, ref) => {
    const inputRef = useRef<TextInput>(null);
    const [isWrapperFocused, setIsWrapperFocused] = useState(false);
    useImperativeHandle(ref, () => inputRef.current as TextInput);

    useTVEventHandler((event) => {
      if (isWrapperFocused && event.eventType === "select") {
        inputRef.current?.focus();
      }
    });

    return (
      <Pressable
        hasTVPreferredFocus={preferredFocus}
        onFocus={() => {
          setIsWrapperFocused(true);
          onActivate();
        }}
        onBlur={() => setIsWrapperFocused(false)}
        onPress={Platform.isTV ? undefined : () => inputRef.current?.focus()}
        style={[
          styles.inputWrapper,
          hasError && styles.inputWrapperError,
          (isWrapperFocused || isActive) && styles.inputWrapperActive,
        ]}
      >
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholderTextColor="#888"
          onFocus={(event) => {
            onActivate();
            onFocus?.(event);
          }}
          {...inputProps}
        />
      </Pressable>
    );
  }
);
FormInput.displayName = "FormInput";

const DISCLAIMER =
  "本应用仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。";

/** 登录 / 添加账号、在登录失效时为某个账号重新输入密码，或修改当前账号的密码 */
export const AccountFormModal: React.FC = () => {
  const pathname = usePathname();
  const form = useAccountStore((state) => state.form);
  const accounts = useAccountStore((state) => state.accounts);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const { closeForm, addAccount, reauth, changePassword, showPicker, showPanel } = useAccountStore.getState();
  const isMobile = useResponsiveLayout().deviceType === "mobile";
  const remoteInputEnabled = useSettingsStore((state) => state.remoteInputEnabled);
  const apiBaseUrl = useSettingsStore((state) => state.apiBaseUrl);
  const serverUrl = useRemoteControlStore((state) => state.serverUrl);
  const lastMessage = useRemoteControlStore((state) => state.lastMessage);
  const targetPage = useRemoteControlStore((state) => state.targetPage);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [color, setColor] = useState<string>(ACCOUNT_COLORS[0].bg);
  const [isLoading, setIsLoading] = useState(false);
  const [activeField, setActiveField] = useState<Field>("username");
  const [focusedField, setFocusedField] = useState<Field | null>(null);
  const usernameRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  // 未登录时和旧登录弹窗一样不在设置页弹出，方便先去改服务器地址；已登录时从账号面板打开的表单照常显示
  const isVisible = !!form && (isLoggedIn || !pathname.includes("settings"));
  const reauthAccount = form?.mode === "reauth" ? accounts.find((a) => a.id === form.accountId) : undefined;
  const changeAccount =
    form?.mode === "changePassword" ? accounts.find((a) => a.id === form.accountId) : undefined;
  const isChangePassword = form?.mode === "changePassword";
  const hasOtherAccounts = accounts.some((a) => a.serverUrl === apiBaseUrl && a.id !== reauthAccount?.id);
  // 未登录时打开的「添加账号」就是登录（首次登录、登出后、手机端）
  const isLogin = form?.mode === "add" && !isLoggedIn;
  // 手机扫码输入只在 TV 上提供，PAD 有自己的键盘
  const showRemoteInput = Platform.isTV && remoteInputEnabled && (form?.mode === "add" || isChangePassword);

  // 每次打开时重置表单；登录时带出上次保存的用户名和密码
  useEffect(() => {
    if (!form) return;
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setConfirmError("");
    setIsLoading(false);
    setActiveField(form.mode === "add" ? "username" : "password");
    setColor(pickAccountColor(selectServerAccounts(useAccountStore.getState()).map((a) => a.color)));

    if (form.mode !== "add" || useAuthStore.getState().isLoggedIn) return;
    let cancelled = false;
    LoginCredentialsManager.get().then((credentials) => {
      if (cancelled || !credentials) return;
      setUsername(credentials.username);
      setPassword(credentials.password);
    });
    return () => {
      cancelled = true;
    };
  }, [form]);

  // 打开期间把远程输入的消息指向本表单
  useEffect(() => {
    if (!showRemoteInput) return;
    useRemoteControlStore.setState({ targetPage: REMOTE_TARGET });
    return () => {
      if (useRemoteControlStore.getState().targetPage === REMOTE_TARGET) {
        useRemoteControlStore.setState({ targetPage: null });
      }
    };
  }, [showRemoteInput]);

  useEffect(() => {
    if (!showRemoteInput || !lastMessage || targetPage !== REMOTE_TARGET) return;
    // 密码里可能有下划线，原样使用消息内容
    if (activeField === "username") {
      setUsername(lastMessage);
    } else if (activeField === "confirm") {
      setConfirmPassword(lastMessage);
      setConfirmError("");
    } else {
      setPassword(lastMessage);
    }
    useRemoteControlStore.setState({ lastMessage: null });
  }, [lastMessage, targetPage, activeField, showRemoteInput]);

  const handleChangePassword = async () => {
    if (!changeAccount) return;
    // 与服务器（及其网页端）的校验一致，提前拦下避免白跑一次请求
    if (!password) {
      Toast.show({ type: "error", text1: "请输入新密码" });
      return;
    }
    if (password.trim().length < 6) {
      Toast.show({ type: "error", text1: "新密码长度至少为6位" });
      return;
    }
    if (password === changeAccount.password) {
      Toast.show({ type: "error", text1: "新密码不能与旧密码相同" });
      return;
    }
    if (password !== confirmPassword) {
      setConfirmError("两次输入的密码不一致");
      return;
    }
    Keyboard.dismiss();
    setIsLoading(true);
    try {
      await changePassword(changeAccount.id, password);
      // 手机的账号面板相当于「账号」页，改完回到面板；TV / PAD 回到首页
      if (isMobile) showPanel();
    } catch (error) {
      const isServerError = error instanceof Error && error.name === "ChangePasswordError";
      Toast.show({
        type: "error",
        text1: "修改失败",
        text2: isServerError ? error.message : "请检查网络或服务器地址是否可用",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (isLoading || !form) return;
    if (form.mode === "changePassword") {
      await handleChangePassword();
      return;
    }
    if (form.mode === "add" && (!username.trim() || !password)) {
      Toast.show({ type: "error", text1: "请输入用户名和密码" });
      return;
    }
    if (form.mode === "reauth" && !password) {
      Toast.show({ type: "error", text1: "请输入密码" });
      return;
    }
    Keyboard.dismiss();
    setIsLoading(true);
    const wasLoggedIn = useAuthStore.getState().isLoggedIn;
    try {
      if (form.mode === "add") {
        await addAccount(username.trim(), password, color);
      } else {
        await reauth(form.accountId, password);
      }
      if (!wasLoggedIn) {
        // 与旧登录弹窗一致：登录后重新加载设置（直播源等需要登录），并显示免责声明
        await useSettingsStore.getState().loadSettings();
        setTimeout(() => Alert.alert("免责声明", DISCLAIMER, [{ text: "确定" }]), 100);
      }
    } catch (error) {
      const isUnauthorized = error instanceof Error && error.message === "UNAUTHORIZED";
      Toast.show({
        type: "error",
        text1: "登录失败",
        text2: isUnauthorized ? "用户名或密码错误" : "请检查网络或服务器地址是否可用",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // 修改密码是从账号面板进来的，取消时回到面板（先开面板，面板据此保留「修改密码」行的焦点）
  const handleClose = () => {
    if (isChangePassword) showPanel();
    closeForm();
  };

  const handleSwitchOther = () => {
    closeForm();
    showPicker();
  };

  const renderReauth = () =>
    reauthAccount && (
      <View style={styles.reauthHeader}>
        <AccountAvatar username={reauthAccount.username} color={reauthAccount.color} size={88} showAlert />
        <Text style={styles.title}>{reauthAccount.username} 的登录已失效</Text>
        <Text style={styles.description}>
          {reauthAccount.needsReauth ? "用保存的密码登录没有成功，密码可能已在服务器上修改" : "该账号已登出，请输入密码"}
        </Text>
      </View>
    );

  const renderChangePasswordHeader = () =>
    changeAccount && (
      <View style={styles.reauthHeader}>
        <AccountAvatar username={changeAccount.username} color={changeAccount.color} size={88} />
        <Text style={styles.title}>修改密码</Text>
        <Text style={[styles.description, styles.textCenter]}>
          为「{changeAccount.username}」设置新密码，修改后本机保存的密码会同步更新
        </Text>
      </View>
    );

  const renderHeader = () => {
    if (form?.mode === "reauth") return renderReauth();
    if (isChangePassword) return renderChangePasswordHeader();
    return renderAddHeader();
  };

  const renderAddHeader = () => (
    <View>
      <Text style={styles.title}>{isLogin ? "登录" : "添加账号"}</Text>
      <Text style={styles.description}>
        {isLogin
          ? "登录后账号会保存在本机，之后可添加更多账号并一键切换"
          : "登录后保存在本机，之后可在账号面板一键切换"}
      </Text>
    </View>
  );

  const submitText =
    form?.mode === "reauth" ? "重新登录" : isChangePassword ? "确认修改" : isLogin ? "登录" : "登录并切换";

  return (
    <Modal visible={isVisible} transparent animationType="fade" onRequestClose={handleClose}>
      <ModalToastRoot>
        <View style={styles.overlay}>
          <View style={[styles.card, showRemoteInput && styles.cardWide]}>
            <View style={styles.formColumn}>
              {renderHeader()}

              {form?.mode === "add" && (
                <>
                  <Text style={styles.label}>用户名</Text>
                  <FormInput
                    ref={usernameRef}
                    isActive={focusedField === "username"}
                    onActivate={() => {
                      setActiveField("username");
                      setFocusedField("username");
                    }}
                    onBlur={() => setFocusedField(null)}
                    preferredFocus
                    placeholder="请输入用户名"
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={username}
                    onChangeText={setUsername}
                    returnKeyType="next"
                    onSubmitEditing={() => passwordRef.current?.focus()}
                    blurOnSubmit={false}
                  />
                </>
              )}

              <Text style={styles.label}>{isChangePassword ? "新密码" : "密码"}</Text>
              <FormInput
                ref={passwordRef}
                isActive={focusedField === "password"}
                onActivate={() => {
                  setActiveField("password");
                  setFocusedField("password");
                }}
                onBlur={() => setFocusedField(null)}
                preferredFocus={form?.mode === "reauth" || isChangePassword}
                placeholder={isChangePassword ? "请输入新密码" : "请输入密码"}
                secureTextEntry
                value={password}
                onChangeText={setPassword}
                returnKeyType={isChangePassword ? "next" : "go"}
                onSubmitEditing={isChangePassword ? () => confirmRef.current?.focus() : handleSubmit}
                blurOnSubmit={!isChangePassword}
              />

              {isChangePassword && (
                <>
                  <Text style={styles.label}>确认新密码</Text>
                  <FormInput
                    ref={confirmRef}
                    isActive={focusedField === "confirm"}
                    hasError={!!confirmError}
                    onActivate={() => {
                      setActiveField("confirm");
                      setFocusedField("confirm");
                    }}
                    onBlur={() => setFocusedField(null)}
                    placeholder="请再次输入新密码"
                    secureTextEntry
                    value={confirmPassword}
                    onChangeText={(text) => {
                      setConfirmPassword(text);
                      setConfirmError("");
                    }}
                    returnKeyType="go"
                    onSubmitEditing={handleSubmit}
                  />
                  {!!confirmError && <Text style={styles.errorText}>{confirmError}</Text>}
                </>
              )}

              {form?.mode === "add" && (
                <>
                  <Text style={styles.label}>头像颜色</Text>
                  <View style={styles.swatches}>
                    {ACCOUNT_COLORS.map((c) => (
                      <Pressable
                        key={c.bg}
                        onPress={() => setColor(c.bg)}
                        style={({ focused }) => [
                          styles.swatchRing,
                          color === c.bg && styles.swatchSelected,
                          focused && styles.swatchFocused,
                        ]}
                      >
                        <View style={[styles.swatch, { backgroundColor: c.bg }]} />
                      </Pressable>
                    ))}
                  </View>
                </>
              )}

              <View style={styles.buttons}>
                <StyledButton
                  text={isLoading ? "" : submitText}
                  variant="primary"
                  onPress={handleSubmit}
                  disabled={isLoading}
                  style={styles.primaryButton}
                >
                  {isLoading && <ActivityIndicator color="#fff" />}
                </StyledButton>
                {form?.mode === "reauth" && hasOtherAccounts ? (
                  <StyledButton text="换个账号" onPress={handleSwitchOther} style={styles.secondaryButton} />
                ) : (
                  <StyledButton text="取消" onPress={handleClose} style={styles.secondaryButton} />
                )}
              </View>
            </View>

            {showRemoteInput && (
              <View style={styles.remoteColumn}>
                <View style={styles.qrBox}>
                  {serverUrl ? (
                    <QRCode value={serverUrl} size={180} backgroundColor="white" color="black" />
                  ) : (
                    <Text style={styles.qrPlaceholder}>正在生成二维码...</Text>
                  )}
                </View>
                <Text style={styles.remoteTitle}>手机扫码输入</Text>
                <Text style={styles.remoteDescription}>
                  发送的内容会填入当前选中的{isChangePassword && activeField === "password" ? "新密码" : FIELD_LABELS[activeField]}框
                </Text>
              </View>
            )}
          </View>
        </View>
      </ModalToastRoot>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(5, 5, 7, 0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    flexDirection: "row",
    width: 480,
    maxWidth: "100%",
    padding: 32,
    borderRadius: 18,
    backgroundColor: "#1c1d21",
    borderWidth: 1,
    borderColor: "#2e3035",
  },
  cardWide: {
    width: 820,
  },
  formColumn: {
    flex: 1,
  },
  reauthHeader: {
    alignItems: "center",
  },
  title: {
    color: "#f2f2f2",
    fontSize: 26,
    fontWeight: "bold",
    marginTop: 12,
  },
  description: {
    color: "#a3a3a8",
    fontSize: 15,
    marginTop: 6,
    marginBottom: 8,
  },
  label: {
    color: "#c9c9ce",
    fontSize: 15,
    marginTop: 16,
    marginBottom: 8,
  },
  inputWrapper: {
    height: 52,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#55575e",
    backgroundColor: "#2a2b30",
    justifyContent: "center",
  },
  inputWrapperActive: {
    borderColor: Colors.dark.primary,
  },
  inputWrapperError: {
    borderColor: "#e5484d",
  },
  errorText: {
    color: "#e5484d",
    fontSize: 13,
    marginTop: 6,
  },
  textCenter: {
    textAlign: "center",
  },
  input: {
    height: 48,
    color: "#f2f2f2",
    paddingHorizontal: 14,
    fontSize: 17,
  },
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  swatchRing: {
    padding: 3,
    marginRight: 10,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "transparent",
  },
  swatchSelected: {
    borderColor: "#f2f2f2",
  },
  swatchFocused: {
    borderColor: Colors.dark.primary,
    transform: [{ scale: 1.1 }],
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  // 按钮获得焦点时会放大 1.1 倍，间距要大于两侧按钮各自多出的宽度，避免叠在一起
  buttons: {
    flexDirection: "row",
    marginTop: 28,
  },
  primaryButton: {
    flex: 1,
    height: 52,
    marginRight: 32,
  },
  secondaryButton: {
    width: 120,
    height: 52,
  },
  remoteColumn: {
    width: 240,
    marginLeft: 32,
    paddingLeft: 32,
    borderLeftWidth: 1,
    borderLeftColor: "#2e3035",
    alignItems: "center",
    justifyContent: "center",
  },
  qrBox: {
    width: 200,
    height: 200,
    borderRadius: 12,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  qrPlaceholder: {
    color: "#55575e",
    fontSize: 14,
  },
  remoteTitle: {
    color: "#f2f2f2",
    fontSize: 18,
    marginTop: 16,
  },
  remoteDescription: {
    color: "#a3a3a8",
    fontSize: 13,
    marginTop: 6,
    textAlign: "center",
  },
});
