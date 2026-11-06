# 바른배차 1.13.0(23) — 회사 ERP native 전표 연결

소스: `codex/free-node-test`의 `4b1b047`.

[Android APK](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.13.0-4b1b047/bareun-dispatch-1.13.0.apk) · [A16 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.13.0-4b1b047/bareun-a16.zip) · [ERP 자동 설치 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.13.0-4b1b047/bareun-erp-install.zip) · [ERP 수동 교체 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.13.0-4b1b047/bareun-company-erp.zip)

실제 회사 편집기 `native_trade_edit.php`는 기존 연동이 읽던 저장소와 달랐습니다. 제공된 실제 소스에 맞춰 현재 원본 버전과 최신 ERP 수정본, 전체 헤더·품목·확인된 금액을 읽도록 연결했습니다. 전표번호/실제 문서 ID 선택 → 최신 전체 내용 확인 → 확인 한 번 등록 → 지역별 배차 추천 순서입니다. 미확인 금액·세율은 0원이나 10%로 추정하지 않으며, 참고 소매/도매 가격을 기존 전표에 덮어쓰지 않습니다. 회사 내부 원본 이관 테이블을 읽는 기능이며 외부 E카운트 API 연결은 추가하지 않았습니다.

적용:

1. 자동 설치 ZIP의 `bareun_update_1_13.php` 하나를 FTP의 기존 `tire/erp`에 올립니다.
2. ERP 관리자로 https://bobjjangs1231.dothome.co.kr/tire/erp/bareun_update_1_13.php 를 열어 **백업하고 ERP 파일 7개 적용**을 누릅니다. 설정·연동키·기존 native helper·DB 원본·재고는 유지합니다. 성공 시 설치기를 삭제하고 실제 최근 전표 확인 화면으로 이동합니다. 예시 번호 49를 강제 조회하지 않습니다.
3. Render는 사용자가 `codex/free-node-test`의 `4b1b047`를 배포합니다. 필요한 기존 자료를 먼저 보관하세요.
4. APK를 기존 앱 위에 설치합니다. A16 ZIP은 압축을 풀어 설치합니다. iOS는 보류 상태입니다.

검증:

- 서버 전체 회귀 테스트: 232
- 실제 제공된 ERP 편집기·PHP·MariaDB: 16
- 인증 API·Node 통합: 14
- 모바일 웹 화면: 4
- 실제 표시 번호·누락 도우미 처리: 2
- TypeScript 형식 검사: 통과
- 모바일 웹 export: 통과
- Android clean prebuild: 통과
- Android ARM64·ARM32 서명·16KB 정렬·동일 인증서 검증: 통과
- 내장 OCR 모델·위치 서비스·최신 ERP 화면 번들 검사: 통과
- Galaxy A16 ARM64 전용 APK 검증: 통과
- 자동 설치기 9개: 관리자·CSRF·7개 해시·기존 설정/키/helper 보존·자동 삭제·installed=1 이동·재실행·경로/심볼릭링크 거절·부분/전체 교체 후 복구·변조 거절·잠금.

실제 제공된 ERP 소스와 가상 데이터로 검증했습니다. 운영 회사 DB의 인증된 129470 전표, FTP 적용·Render 배포·실물 카메라/GPS를 이 환경에서 직접 확인한 것은 아닙니다. APK/ZIP에는 PIN·DB 설정·연동키·고객 전표나 제공된 비공개 native helper 원본을 포함하지 않습니다.
