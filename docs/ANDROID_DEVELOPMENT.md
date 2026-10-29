# Expo Android 개발 빌드

Expo Go, 개발 빌드, 직원에게 설치하는 앱은 같은 Node.js API 서버를 사용할 수 있습니다. 개발 방식 때문에 서버를 새로 만들지 않습니다. 배포 앱에는 실제 HTTPS 서버 주소를, 로컬 개발에서는 개발 기기에서 접근 가능한 API 주소를 사용합니다.

Expo Go는 iOS·Android 공통 화면을 빠르게 확인하는 용도입니다. 이 앱의 백그라운드 위치 공유처럼 자체 네이티브 설정이 필요한 기능은 개발 빌드에서 확인합니다. 이 문서의 실제 준비 환경은 Linux x86_64 클라우드입니다. 사용자 PC의 Android Studio 에뮬레이터를 원격으로 제어하는 연결이 아닙니다.

## 프로젝트 명령

이 프로젝트는 npm과 package-lock.json을 사용합니다. 실행한 설치·네이티브 생성 명령은 다음과 같습니다.

```bash
npx expo install expo-dev-client --npm
npx expo prebuild --clean --platform android
```

첫 prebuild에서 앱의 밝은 화면 테마 설정에 필요한 모듈 경고가 있어 `npx expo install expo-system-ui --npm`으로 SDK 호환 모듈을 추가한 뒤 같은 clean 명령을 다시 실행했습니다.

네이티브 의존성 또는 app.json의 네이티브 설정을 변경했다면 `npx expo prebuild --clean --platform android` 후 다시 빌드합니다. `--clean`은 생성된 android 폴더를 교체하므로 수동 네이티브 변경·기존 사용자 파일이 있으면 먼저 보존하고 재생성할 내용을 확인합니다. 이 작업의 첫 실행 전에는 android·ios 폴더가 없었습니다. 생성된 네이티브 폴더는 기존 .gitignore에 따라 제외됩니다.

Android Studio와 에뮬레이터가 준비된 개발 PC에서는 다음 순서로 실행합니다.

```bash
npx expo run:android --no-bundler
npx expo start --dev-client
```

실제 연결한 Android 휴대폰에 설치할 때는 `npx expo run:android --device --no-bundler`를 사용합니다. 개발 빌드는 JavaScript 개발 서버가 필요한 앱이며 직원용 독립 실행 APK와 구분합니다.

iOS 로컬 빌드는 Mac과 Xcode에서 `npx expo prebuild --clean --platform ios`, `npx expo run:ios`로 진행합니다. 이 작업에서는 Android 에뮬레이터가 선택되어 iOS 컴파일을 실행하지 않았습니다.

## 현재 클라우드의 도구

준비한 도구는 다음과 같습니다.

- JDK 21: Gradle 실행과 SDK 도구용.
- JDK 17: React Native Gradle 플러그인이 명시적으로 요구하는 컴파일 도구 체인.
- Android SDK 36, Build Tools 36.0.0과 Gradle이 추가 설치한 35.0.0, NDK 27.1.12297006, CMake 3.22.1.
- Android API 36 Google APIs x86_64 이미지와 `Bareun_API_36` 가상 기기.
- 프로젝트 wrapper의 Gradle 9.3.1. 공식 배포 SHA-256을 설정했습니다.

공식 JDK와 SDK 도구의 URL·체크섬은 `deploy/android/toolchain.json`에 기록했습니다. JDK는 SHA-256, SDK 명령행 도구는 Google 메타데이터의 체크섬·크기로 검증합니다. 필요한 도구를 다시 준비할 때는 `python3 scripts/setup-cloud-android.py --with-emulator`를 실행합니다. 기존의 다른 Gradle 설정은 보존하며 필수 설정과 충돌하면 중단합니다.

각 클라우드 터미널에서 도구를 활성화합니다.

```bash
cd /workspace/-system
source scripts/cloud-android-env.sh
```

Java와 Gradle은 이 환경이 제공한 프록시와 CA 신뢰를 유지합니다. 프로젝트가 요구하는 JDK 17을 설치해 해결했으며, 요구 버전을 바꾸거나 TLS·체크섬 검증을 끄지 않았습니다. 네트워크 정책에 없는 저장소를 프록시 우회로 조회하지 않습니다.

## 클라우드 가상 기기

이 클라우드는 /dev/kvm과 VMX·SVM 가속 기능이 노출되지 않았습니다. 아래 소프트웨어 모드로 에뮬레이터를 시작해 ADB 연결과 `sys.boot_completed=1`을 확인했습니다. 첫 부팅은 느리며 기기 연결과 Android 부팅 완료는 구분해서 확인합니다.

```bash
source scripts/cloud-android-env.sh
emulator -avd Bareun_API_36 -no-window -no-audio -no-boot-anim -no-snapshot -accel off -gpu swiftshader_indirect -memory 2048 -cores 2 -camera-back none -camera-front none
```

다른 터미널에서 `adb devices -l`, `adb -s emulator-5554 shell getprop sys.boot_completed`로 확인합니다. localhost의 API를 쓸 경우 앱을 설치한 뒤 ADB 포트를 연결합니다.

```bash
adb -s emulator-5554 reverse tcp:4000 tcp:4000
adb -s emulator-5554 reverse tcp:8081 tcp:8081
EXPO_PUBLIC_API_URL=http://127.0.0.1:4000 npx expo start --dev-client --localhost --port 8081
```

위 개발 주소를 직원용 앱의 실제 서버 주소로 사용하지 않습니다. 직원용 빌드에서는 카페24의 HTTPS API 주소를 설정합니다.

## 개발 빌드 기록과 LDPlayer APK

이후 네트워크 허용이 실행 환경에 반영되었고 독립 실행 release APK를 생성해 서명·무결성 검증을 마쳤습니다. 파일은 `/workspace/artifacts/bareun-dispatch-ldplayer-x86_64-test-0ee74c4.apk`이며 Metro가 필요 없습니다. LDPlayer 9 64비트 설치 절차와 검증 범위는 [LDPLAYER_APK.md](LDPLAYER_APK.md)를 따릅니다. 실제 LDPlayer 설치·실행은 아직 확인하지 않았습니다. 아래 내용은 이전 debug 개발 빌드 시도의 기록입니다.

직접 Gradle 컴파일에서 플러그인·앱 코드 생성과 리소스 작업까지 실행됐지만, 필수 React Native 0.86.3 debug AAR을 Maven에서 내려받는 과정이 `repo.reactnative.dev`로 연결되며 403으로 차단되었습니다. 허용된 Maven Central 두 호스트에서도 같은 문제를 확인했습니다. 필요한 `repo.reactnative.dev` 접근 요구사항은 환경 초안에 추가했습니다. 저장된 초안과 실행 환경의 실제 적용 상태는 별개입니다.

네트워크 설정 적용 후 아래 명령으로 이어서 컴파일·설치합니다. 유효한 Gradle 캐시를 재사용하며 앱 코드나 네이티브 설정이 바뀌지 않았다면 clean을 반복하지 않습니다.

```bash
source scripts/cloud-android-env.sh
NODE_ENV=development EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npx expo run:android --device Bareun_API_36 --no-bundler
```

APK가 실제로 생성·설치된 다음 `npx expo start --dev-client`를 실행하고 앱 화면을 확인해야 완료입니다. ADB 연결, 열린 포트, JavaScript 번들만으로 네이티브 설치 성공을 주장하지 않습니다.
