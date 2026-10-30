import React, { useEffect, useRef } from "react";
import {
  Text,
  View,
  Pressable,
  TextInput,
  StyleSheet,
  Modal,
  ScrollView,
  ActivityIndicator,
  AccessibilityInfo,
  Animated,
  Image,
  Platform,
} from "react-native";
import { X, ArrowRight } from "lucide-react-native";
export const C = {
  ink: "#152e34",
  muted: "#718188",
  green: "#235b4e",
  lime: "#c9ef8b",
  bg: "#f4f6f5",
  line: "#e4eae7",
  white: "#ffffff",
  red: "#be4d4a",
  amber: "#b37d26",
};
export function Button({
  title,
  onPress,
  secondary = false,
  danger = false,
  disabled = false,
  icon: Icon,
  small = false,
}: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  icon?: any;
  small?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        small && { minHeight: 38, paddingVertical: 9, paddingHorizontal: 13 },
        secondary && s.secondary,
        danger && { backgroundColor: "#fff0ee" },
        disabled && { opacity: 0.45 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {Icon && (
        <Icon
          size={small ? 16 : 19}
          color={danger ? C.red : secondary ? C.ink : C.white}
        />
      )}
      <Text
        style={[
          s.buttonText,
          secondary && { color: C.ink },
          danger && { color: C.red },
          small && { fontSize: 12 },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Field({
  label,
  value,
  onChangeText,
  placeholder = "",
  numeric = false,
  multiline = false,
  secure = false,
}: {
  label: string;
  value: string;
  onChangeText: (s: string) => void;
  placeholder?: string;
  numeric?: boolean;
  multiline?: boolean;
  secure?: boolean;
}) {
  return (
    <View style={{ gap: 7, marginBottom: 13 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#9aa7a4"
        keyboardType={numeric ? "numeric" : "default"}
        secureTextEntry={secure}
        multiline={multiline}
        style={[
          s.input,
          multiline && { minHeight: 76, textAlignVertical: "top" },
        ]}
      />
    </View>
  );
}
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: any;
}) {
  return <View style={[s.card, style]}>{children}</View>;
}
export function Badge({
  text,
  tone = "green",
}: {
  text: string;
  tone?: "green" | "amber" | "red" | "grey";
}) {
  const colors = {
    green: ["#edf5ea", C.green],
    amber: ["#fff5df", C.amber],
    red: ["#fff0ee", C.red],
    grey: ["#eff2f2", C.muted],
  }[tone];
  return (
    <View
      style={{
        backgroundColor: colors[0],
        borderRadius: 7,
        paddingHorizontal: 8,
        paddingVertical: 4,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ fontSize: 10, fontWeight: "700", color: colors[1] }}>
        {text}
      </Text>
    </View>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Card style={{ paddingVertical: 35, alignItems: "center", gap: 10 }}>
      <View
        style={{
          height: 42,
          width: 42,
          borderRadius: 15,
          backgroundColor: "#edf4e8",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ArrowRight size={21} color={C.green} />
      </View>
      <Text style={s.h3}>{title}</Text>
      <Text
        style={[
          s.muted,
          { textAlign: "center", maxWidth: 300, lineHeight: 21 },
        ]}
      >
        {description}
      </Text>
      {action}
    </Card>
  );
}
export function Sheet({
  title,
  visible,
  onClose,
  children,
}: {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={s.overlay}>
        <View style={s.sheet}>
          <View
            style={[
              s.row,
              {
                justifyContent: "space-between",
                padding: 22,
                borderBottomWidth: 1,
                borderBottomColor: C.line,
              },
            ]}
          >
            <Text style={s.h2}>{title}</Text>
            <Pressable
              accessibilityLabel="닫기"
              onPress={onClose}
              style={{ padding: 7 }}
            >
              <X size={22} color={C.ink} />
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 22, paddingBottom: 40 }}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
export function Loading() {
  const pulse = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    let cancelled = false;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1100,
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(pulse, {
          toValue: 0.5,
          duration: 1100,
          useNativeDriver: Platform.OS !== "web",
        }),
      ]),
    );
    AccessibilityInfo.isReduceMotionEnabled()
      .then((reduced) => {
        if (!cancelled && !reduced) animation.start();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      animation.stop();
    };
  }, [pulse]);
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#153b36",
      }}
    >
      <Image
        source={require("../assets/icon.png")}
        accessibilityLabel="바른배차 배송 차량 로고"
        style={{ width: 164, height: 164, borderRadius: 38, marginBottom: 25 }}
      />
      <Text
        style={{
          color: "#c9ef8b",
          fontSize: 10,
          fontWeight: "700",
          letterSpacing: 4,
        }}
      >
        BAREUN DISPATCH
      </Text>
      <Text
        style={{
          color: "#fffdf1",
          fontSize: 36,
          fontWeight: "800",
          letterSpacing: -1,
          marginTop: 10,
        }}
      >
        바른배차
      </Text>
      <Text style={{ color: "#bed1c9", fontSize: 13, marginTop: 12 }}>
        오늘의 배송을, 바른 순서로.
      </Text>
      <Animated.View
        style={{
          opacity: pulse,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginTop: 42,
        }}
      >
        <ActivityIndicator color="#c9ef8b" size="small" />
        <Text style={{ color: "#d5e4dc", fontSize: 12 }}>
          배송 정보를 준비하고 있어요
        </Text>
      </Animated.View>
    </View>
  );
}
export const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  between: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  card: {
    backgroundColor: C.white,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: C.line,
    marginBottom: 13,
  },
  h1: { fontSize: 27, fontWeight: "800", color: C.ink, letterSpacing: -1 },
  h2: { fontSize: 20, fontWeight: "800", color: C.ink, letterSpacing: -0.6 },
  h3: { fontSize: 15, fontWeight: "700", color: C.ink },
  muted: { fontSize: 12, color: C.muted, lineHeight: 19 },
  label: { fontSize: 12, fontWeight: "700", color: C.ink },
  input: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    minHeight: 47,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
    color: C.ink,
    backgroundColor: "#fafcfb",
  },
  button: {
    minHeight: 48,
    paddingHorizontal: 19,
    paddingVertical: 13,
    borderRadius: 13,
    backgroundColor: C.green,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  secondary: { backgroundColor: "#eff3ef" },
  buttonText: { color: C.white, fontSize: 13, fontWeight: "700" },
  overlay: {
    flex: 1,
    backgroundColor: "#0b252c88",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  sheet: {
    backgroundColor: C.bg,
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
    maxHeight: "91%",
    width: "100%",
    maxWidth: 650,
  },
  divider: { height: 1, backgroundColor: C.line, marginVertical: 16 },
  num: { fontSize: 29, fontWeight: "800", color: C.ink, letterSpacing: -1 },
  section: {
    fontSize: 12,
    fontWeight: "700",
    color: C.muted,
    letterSpacing: 1.2,
    marginBottom: 13,
  },
});
