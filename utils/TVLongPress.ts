import { Platform } from "react-native";

/**
 * Android TV 按住 OK 时，react-native-tvos 会发出两次 longSelect：按住时一次（eventKeyAction=0），
 * 松手时再一次（eventKeyAction=1），Pressable 的 onLongPress 因此会被调用两次。
 * 长按处理只应响应按住时那一次；触屏的长按事件没有 eventKeyAction，不受影响。
 */
export const isTVLongPressRelease = (event: unknown) =>
  Platform.isTV && (event as { eventKeyAction?: number } | undefined)?.eventKeyAction === 1;
