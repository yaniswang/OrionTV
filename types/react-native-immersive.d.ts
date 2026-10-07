declare module 'react-native-immersive' {
  export const Immersive: {
    on(): void;
    off(): void;
    setImmersive?(enabled: boolean): void;
  };
}
