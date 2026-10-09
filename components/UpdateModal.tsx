import React from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { useUpdateStore } from "../stores/updateStore";
import { Colors } from "../constants/Colors";
import { UPDATE_CONFIG } from "../constants/UpdateConfig";
import { useResponsiveLayout } from "../hooks/useResponsiveLayout";
import { StyledButton } from "./StyledButton";
import { ThemedText } from "./ThemedText";
import { ModalToastRoot } from "../utils/Toast";

interface ReleaseNotesCardProps {
  lines: string[];
  publishedAt: string;
  showMeta: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

interface VersionInfoCardProps {
  remoteVersion: string;
  publishedAt: string;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

function getReleaseNoteLines(releaseNotes: string): string[] {
  return releaseNotes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:[-*•+]|\d+[.)]|#{1,6})\s*/, ""));
}

function formatPublishedAt(publishedAt: string): string {
  if (!publishedAt) return "";

  const dateParts = publishedAt.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (dateParts) {
    const month = dateParts[2].padStart(2, "0");
    const day = dateParts[3].padStart(2, "0");
    return `${dateParts[1]}-${month}-${day}`;
  }

  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return publishedAt;

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function ReleaseNotesCard({ lines, publishedAt, showMeta, compact = false, style }: ReleaseNotesCardProps) {
  return (
    <View style={[styles.releaseNotesCard, compact && styles.compactCard, style]}>
      <ThemedText style={[styles.cardTitle, compact && styles.compactCardTitle]}>更新内容</ThemedText>

      <View style={[styles.notesList, compact && styles.compactNotesList]}>
        {lines.length > 0 ? (
          lines.map((line, index) => (
            <View key={`${index}-${line}`} style={styles.noteRow}>
              <View style={[styles.noteDot, compact && styles.compactNoteDot]} />
              <ThemedText style={[styles.noteText, compact && styles.compactNoteText]}>{line}</ThemedText>
            </View>
          ))
        ) : (
          <ThemedText style={[styles.emptyNotesText, compact && styles.compactNoteText]}>暂无更新说明</ThemedText>
        )}
      </View>

      {showMeta && (
        <>
          <View style={[styles.divider, compact && styles.compactDivider]} />
          {!!publishedAt && (
            <ThemedText style={[styles.metaText, compact && styles.compactMetaText]}>
              发布时间: {publishedAt}
            </ThemedText>
          )}
          <ThemedText style={[styles.metaText, styles.scrollHint, compact && styles.compactMetaText]}>
            更新内容较长时可上下滚动
          </ThemedText>
        </>
      )}
    </View>
  );
}

function VersionInfoCard({ remoteVersion, publishedAt, compact = false, style }: VersionInfoCardProps) {
  return (
    <View style={[styles.versionCard, compact && styles.compactCard, style]}>
      <ThemedText style={[styles.cardTitle, compact && styles.compactCardTitle]}>版本信息</ThemedText>
      <ThemedText style={[styles.versionValue, compact && styles.compactVersionValue]}>
        Release v{remoteVersion}
      </ThemedText>
      {!!publishedAt && (
        <ThemedText style={[styles.metaText, compact && styles.compactMetaText]}>
          发布时间: {publishedAt}
        </ThemedText>
      )}
    </View>
  );
}

export function UpdateModal() {
  const {
    showUpdateModal,
    currentVersion,
    remoteVersion,
    releaseNotes,
    publishedAt,
    downloading,
    downloadProgress,
    error,
    setShowUpdateModal,
    startDownload,
    installUpdate,
    skipThisVersion,
    downloadedPath,
  } = useUpdateStore();
  const { deviceType, isPortrait, screenWidth, screenHeight } = useResponsiveLayout();

  const updateButtonRef = React.useRef<View>(null);
  const laterButtonRef = React.useRef<View>(null);
  const skipButtonRef = React.useRef<View>(null);
  const isLandscape = deviceType === "tv" || !isPortrait;
  const isCompactLandscape = isLandscape && Math.min(screenWidth, screenHeight) < 600;
  const releaseNoteLines = getReleaseNoteLines(releaseNotes);
  const formattedPublishedAt = formatPublishedAt(publishedAt);
  const showReleaseNotes = UPDATE_CONFIG.SHOW_RELEASE_NOTES;

  async function handleUpdate() {
    if (!downloading && !downloadedPath) {
      // 开始下载
      await startDownload();
    } else if (downloadedPath) {
      // 已下载完成，安装
      await installUpdate();
    }
  }

  function handleLater() {
    setShowUpdateModal(false);
  }

  async function handleSkip() {
    await skipThisVersion();
  }

  React.useEffect(() => {
    if (showUpdateModal && Platform.isTV) {
      // TV平台自动聚焦到更新按钮
      setTimeout(() => {
        updateButtonRef.current?.focus();
      }, 100);
    }
  }, [showUpdateModal]);

  const getButtonText = () => {
    if (downloading) {
      return `下载中 ${downloadProgress}%`;
    } else if (downloadedPath) {
      return "立即安装";
    } else {
      return "立即更新";
    }
  };

  return (
    <Modal
      visible={showUpdateModal}
      transparent
      animationType="fade"
      onRequestClose={handleLater}
      supportedOrientations={["portrait", "portrait-upside-down", "landscape", "landscape-left", "landscape-right"]}
    >
      <ModalToastRoot>
        <View style={styles.overlay}>
          <View
            style={[
              styles.container,
              isLandscape ? styles.landscapeContainer : styles.portraitContainer,
              isCompactLandscape && styles.compactContainer,
            ]}
          >
            <View style={[styles.header, isCompactLandscape && styles.compactHeader]}>
              <ThemedText style={[styles.title, isCompactLandscape && styles.compactTitle]}>
                发现新版本
              </ThemedText>

              <View style={[styles.versionInfo, isCompactLandscape && styles.compactVersionInfo]}>
                <ThemedText style={[styles.versionText, isCompactLandscape && styles.compactVersionText]}>
                  当前 v{currentVersion}
                </ThemedText>
                <ThemedText style={[styles.arrow, isCompactLandscape && styles.compactArrow]}>→</ThemedText>
                <ThemedText
                  style={[
                    styles.versionText,
                    styles.newVersion,
                    isCompactLandscape && styles.compactVersionText,
                  ]}
                >
                  新版本 v{remoteVersion}
                </ThemedText>
              </View>
            </View>

            <ScrollView
              style={styles.scrollView}
              contentContainerStyle={[styles.scrollContent, isCompactLandscape && styles.compactScrollContent]}
              showsVerticalScrollIndicator={false}
            >
              {showReleaseNotes && (
                <View
                  style={[
                    styles.mainBody,
                    isLandscape && styles.mainBodyLandscape,
                    isCompactLandscape && styles.compactMainBodyLandscape,
                  ]}
                >
                  <ReleaseNotesCard
                    lines={releaseNoteLines}
                    publishedAt={formattedPublishedAt}
                    showMeta={!isLandscape}
                    compact={isCompactLandscape}
                    style={isLandscape ? styles.releaseNotesCardLandscape : styles.releaseNotesCardPortrait}
                  />
                  {isLandscape && (
                    <VersionInfoCard
                      remoteVersion={remoteVersion}
                      publishedAt={formattedPublishedAt}
                      compact={isCompactLandscape}
                      style={[
                        styles.versionCard,
                        deviceType === "mobile" && styles.versionCardMobile,
                        isCompactLandscape && styles.compactVersionCard,
                      ]}
                    />
                  )}
                </View>
              )}

              {downloading && (
                <View style={styles.progressContainer}>
                  <View style={styles.progressBar}>
                    <View style={[styles.progressFill, { width: `${downloadProgress}%` }]} />
                  </View>
                  <ThemedText style={styles.progressText}>{downloadProgress}%</ThemedText>
                </View>
              )}

              {error && <ThemedText style={styles.errorText}>{error}</ThemedText>}
            </ScrollView>

            <View
              style={[
                styles.buttonContainer,
                isLandscape && styles.buttonContainerLandscape,
                isCompactLandscape && styles.compactButtonContainer,
              ]}
            >
              <StyledButton
                ref={updateButtonRef}
                onPress={handleUpdate}
                disabled={downloading && !downloadedPath}
                variant="default"
                isSelected
                style={[
                  isLandscape ? styles.landscapeButton : styles.button,
                  isCompactLandscape && styles.compactLandscapeButton,
                ]}
              >
                {downloading && !downloadedPath ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <ThemedText style={[styles.buttonText, isCompactLandscape && styles.compactButtonText]}>
                    {getButtonText()}
                  </ThemedText>
                )}
              </StyledButton>

              {!downloading && !downloadedPath && (
                <>
                  <StyledButton
                    ref={laterButtonRef}
                    onPress={handleLater}
                    variant="default"
                    style={[
                      isLandscape ? styles.landscapeButton : styles.button,
                      isCompactLandscape && styles.compactLandscapeButton,
                    ]}
                  >
                    <ThemedText style={[styles.buttonText, isCompactLandscape && styles.compactButtonText]}>
                      稍后再说
                    </ThemedText>
                  </StyledButton>

                  <StyledButton
                    ref={skipButtonRef}
                    onPress={handleSkip}
                    variant="default"
                    style={[
                      isLandscape ? styles.landscapeButton : styles.button,
                      isCompactLandscape && styles.compactLandscapeButton,
                    ]}
                  >
                    <ThemedText style={[styles.buttonText, isCompactLandscape && styles.compactButtonText]}>
                      跳过此版本
                    </ThemedText>
                  </StyledButton>
                </>
              )}
            </View>
          </View>
        </View>
      </ModalToastRoot>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
  },
  container: {
    backgroundColor: Colors.dark.background,
    borderRadius: 20,
    padding: 35,
    maxHeight: "92%",
    width: "100%",
    overflow: "hidden",
  },
  compactContainer: {
    borderRadius: 16,
    padding: 16,
  },
  header: {
    width: "100%",
    gap: 12,
    marginBottom: 20,
  },
  compactHeader: {
    gap: 6,
    marginBottom: 10,
  },
  portraitContainer: {
    width: "90%",
    maxWidth: 500,
  },
  landscapeContainer: {
    width: "78%",
    maxWidth: 780,
  },
  scrollView: {
    flexShrink: 1,
    width: "100%",
  },
  scrollContent: {
    width: "100%",
    gap: 24,
  },
  compactScrollContent: {
    gap: 12,
  },
  title: {
    fontSize: Platform.isTV ? 28 : 24,
    lineHeight: Platform.isTV ? 40 : 34,
    fontWeight: "bold",
    color: Colors.dark.text,
    textAlign: "center",
    paddingTop: 2,
  },
  compactTitle: {
    fontSize: 18,
    lineHeight: 24,
    paddingTop: 0,
  },
  versionInfo: {
    width: "100%",
    minHeight: 60,
    backgroundColor: "#0f141c",
    borderRadius: 14,
    paddingHorizontal: Platform.isTV ? 24 : 20,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  compactVersionInfo: {
    minHeight: 40,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  versionText: {
    fontSize: Platform.isTV ? 18 : 16,
    lineHeight: 24,
    color: Colors.dark.text,
    flexShrink: 1,
  },
  compactVersionText: {
    fontSize: 13,
    lineHeight: 18,
  },
  newVersion: {
    color: Colors.dark.primary || "#00bb5e",
    fontWeight: "bold",
  },
  arrow: {
    fontSize: Platform.isTV ? 20 : 18,
    lineHeight: 24,
    color: Colors.dark.text,
    marginHorizontal: 12,
  },
  compactArrow: {
    fontSize: 14,
    lineHeight: 18,
    marginHorizontal: 8,
  },
  mainBody: {
    width: "100%",
  },
  mainBodyLandscape: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 20,
  },
  compactMainBodyLandscape: {
    gap: 12,
  },
  releaseNotesCard: {
    backgroundColor: "#0f141c",
    borderColor: "#263241",
    borderWidth: 1,
    borderRadius: 16,
    padding: 35,
  },
  releaseNotesCardPortrait: {
    width: "100%",
  },
  releaseNotesCardLandscape: {
    flex: 1,
    minWidth: 0,
  },
  compactCard: {
    borderRadius: 12,
    padding: 16,
  },
  versionCard: {
    width: 260,
    backgroundColor: "#0f141c",
    borderColor: "#263241",
    borderWidth: 1,
    borderRadius: 16,
    padding: 35,
  },
  versionCardMobile: {
    width: 210,
  },
  compactVersionCard: {
    width: 200,
  },
  cardTitle: {
    fontSize: Platform.isTV ? 22 : 20,
    lineHeight: 28,
    fontWeight: "bold",
    color: "#ffffff",
    marginBottom: 20,
  },
  compactCardTitle: {
    fontSize: 15,
    lineHeight: 20,
    marginBottom: 8,
  },
  notesList: {
    gap: 12,
  },
  compactNotesList: {
    gap: 6,
  },
  noteRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  noteDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.dark.primary || "#00bb5e",
    marginTop: 7,
  },
  compactNoteDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
  },
  noteText: {
    flex: 1,
    fontSize: Platform.isTV ? 18 : 16,
    lineHeight: Platform.isTV ? 28 : 24,
    color: "#e8edf3",
  },
  compactNoteText: {
    fontSize: 13,
    lineHeight: 18,
  },
  emptyNotesText: {
    fontSize: Platform.isTV ? 18 : 16,
    lineHeight: Platform.isTV ? 28 : 24,
    color: "#8f9bad",
  },
  divider: {
    width: "100%",
    height: 1,
    backgroundColor: "#263241",
    marginVertical: 20,
  },
  compactDivider: {
    marginVertical: 12,
  },
  metaText: {
    fontSize: Platform.isTV ? 16 : 14,
    lineHeight: 22,
    color: "#7f8c9b",
  },
  compactMetaText: {
    fontSize: 11,
    lineHeight: 16,
  },
  scrollHint: {
    marginTop: 6,
    color: "#596779",
  },
  versionValue: {
    fontSize: Platform.isTV ? 18 : 16,
    lineHeight: 24,
    fontWeight: "600",
    color: "#e8edf3",
    marginBottom: 12,
  },
  compactVersionValue: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 6,
  },
  progressContainer: {
    width: "100%",
  },
  progressBar: {
    height: 6,
    backgroundColor: Colors.dark.border,
    borderRadius: 3,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressFill: {
    height: "100%",
    backgroundColor: Colors.dark.primary || "#00bb5e",
  },
  progressText: {
    fontSize: Platform.isTV ? 16 : 14,
    color: Colors.dark.text,
    textAlign: "center",
  },
  errorText: {
    width: "100%",
    fontSize: Platform.isTV ? 16 : 14,
    color: "#ff4444",
    textAlign: "center",
  },
  buttonContainer: {
    width: "100%",
    gap: 12,
    marginTop: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonContainerLandscape: {
    flexDirection: "row",
    alignSelf: "center",
    maxWidth: 680,
  },
  compactButtonContainer: {
    gap: 8,
    marginTop: 12,
    maxWidth: 520,
  },
  button: {
    width: "80%",
  },
  landscapeButton: {
    flex: 1,
    minWidth: 140,
    maxWidth: 220,
  },
  compactLandscapeButton: {
    minWidth: 120,
    maxWidth: 160,
  },
  buttonText: {
    fontSize: Platform.isTV ? 18 : 16,
    lineHeight: 24,
    fontWeight: "600",
    color: "#fff",
  },
  compactButtonText: {
    fontSize: 14,
    lineHeight: 20,
  },
});
