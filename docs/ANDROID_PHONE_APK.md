# Android 휴대폰 설치용 APK

휴대폰용은 `arm64-v8a`와 `armeabi-v7a`를 하나의 APK에 포함한다. 최소 Android 버전은 7.0(API 24)이다. 앱 버전은 1.1.0(2)이며 전체 경로 보기, 새 아이콘·시작 화면, 배송 물품·수량, 관리자 위치 공유 화면을 포함한다. Metro나 Expo Go 없이 실행한다.

## 빌드

```bash
cd /workspace/-system
EXPO_PUBLIC_API_URL=https://bareun-dispatch-test.onrender.com bash scripts/build-android-phone-apk.sh
```

이전 Android 생성 프로젝트와 캐시를 재사용한다. 네이티브 의존성이나 앱 설정이 바뀌지 않았으면 ARM 타깃으로 빌드하기 위해 clean prebuild를 반복하지 않는다. 실제 네이티브 변경으로 재생성이 필요하면 기존 서명 키·사용자 변경을 보존한 뒤 재생성하고 `scripts/setup-cloud-android.py`로 SDK·공식 Gradle 체크섬을 적용한다.

스크립트는 release 모드로 JavaScript를 내장한다. APK 서명·16KB ZIP 정렬·ZIP 무결성·두 ARM 아키텍처·내장 번들을 확인한 후 `/workspace/artifacts/bareun-dispatch-android-phone-arm-test-<커밋>.apk`와 `.apk.sha256`을 만든다. 기존 LDPlayer 테스트 APK와 같은 인증서를 유지하는 내부 테스트용 빌드다. 회사 운영용 서명 키를 사용하는 정식 배포 절차는 `INTERNAL_DISTRIBUTION.md`를 따른다.

## 휴대폰 설치

1. Android 휴대폰에서 APK를 다운로드해 연다.
2. Android에서 요청하면 다운로드한 브라우저 또는 파일 앱의 `이 출처의 앱 설치 허용`을 켜고 설치한다.
3. 바른배차를 열고 기존 PIN으로 로그인한다. 현재 연결 주소는 `https://bareun-dispatch-test.onrender.com`이다.
4. 코스 출발 시 위치 권한을 허용한다. 길안내 앱으로 전환한 동안에도 위치를 공유하려면 앱에서 요청하는 백그라운드 위치 권한도 허용한다.

앱 ID와 서명이 같은 기존 버전이 있으면 그 위에 설치한다. 앱 삭제나 계정·배송 내역 초기화는 필요하지 않다. 빌드·패키지 검증과 실제 휴대폰의 GPS·백그라운드 위치 전송 검증은 구분한다. 설치 후 관리자 화면에서 실제 이동에 따라 위치가 갱신되고 회사 복귀 완료 뒤 공유가 중단되는지 확인한다.
