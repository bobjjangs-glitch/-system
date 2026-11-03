/** A registered Expo task does not prove that Android accepted its service. */
export async function waitForLocationService(
  probe: () => Promise<string>,
  assertCurrent: () => void,
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 250)),
) {
  for (let attempt = 0; attempt < 32; attempt++) {
    assertCurrent();
    const state = await probe();
    assertCurrent();
    if (state === "running") return;
    if (state.startsWith("failed:"))
      throw new Error(
        "Android가 백그라운드 위치 서비스 시작을 허용하지 않았습니다. 위치·알림 권한을 확인한 뒤 앱 화면에서 다시 켜 주세요.",
      );
    await pause();
  }
  throw new Error(
    "백그라운드 위치 서비스를 시작하지 못했습니다. 앱 화면에서 다시 켜 주세요.",
  );
}
