import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  ToastPosition,
  toast,
  type ToastOptions,
} from '@backpackapp-io/react-native-toast';
import { Check, Info, X } from 'lucide-react-native';

type LegacyToastType = 'success' | 'error' | 'info';

interface ToastShowOptions {
  type?: LegacyToastType;
  text1?: string;
  text2?: string;
  position?: 'top' | 'bottom' | string;
  visibilityTime?: number;
  duration?: number;
  autoHide?: boolean;
  [key: string]: unknown;
}

interface ToastContentProps {
  type: LegacyToastType;
  message: string;
  width?: number;
}

const TOAST_COLORS: Record<LegacyToastType, string> = {
  info: '#2F80ED',
  success: '#27AE60',
  error: '#EB5757',
};

function ToastIcon({ type }: { type: LegacyToastType }) {
  const color = TOAST_COLORS[type];
  if (type === 'success') {
    return (
      <View style={[styles.iconCircle, { backgroundColor: color }]}>
        <Check color="#fff" size={20} strokeWidth={3} />
      </View>
    );
  }
  if (type === 'error') {
    return (
      <View style={[styles.iconCircle, { backgroundColor: color }]}>
        <X color="#fff" size={20} strokeWidth={3} />
      </View>
    );
  }
  return (
    <View style={[styles.iconCircle, { backgroundColor: color }]}>
      <Info color="#fff" size={19} strokeWidth={3} />
    </View>
  );
}

function ToastContent({ type, message, width }: ToastContentProps) {
  return (
    <View style={[styles.card, width ? { width } : null]}>
      <ToastIcon type={type} />
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

function renderMessage(text1?: string, text2?: string) {
  return [text1, text2].filter(Boolean).join('\n');
}

const Toast = {
  show(options: ToastShowOptions) {
    const {
      type = 'info',
      text1,
      text2,
      position,
      visibilityTime,
      duration,
      autoHide = true,
    } = options;
    const message = renderMessage(text1, text2);
    const toastOptions: ToastOptions = {
      position: position === 'bottom' ? ToastPosition.BOTTOM : ToastPosition.TOP,
      duration: autoHide ? duration ?? visibilityTime : Infinity,
      disableShadow: true,
      customToast: (currentToast) => (
        <ToastContent type={type} message={message} width={currentToast.width} />
      ),
    };

    return toast(message, toastOptions);
  },
};

const styles = StyleSheet.create({
  card: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#212331',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 5,
    elevation: 7,
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    color: '#f2f2f2',
    fontSize: 15,
    lineHeight: 20,
    marginLeft: 10,
  },
});

export default Toast;