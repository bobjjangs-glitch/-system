# 바른배차 1.14.0(24) — 오늘 회사 ERP 판매내역 자동 조회

소스: `codex/free-node-test`의 `8cc843a`.

[Android APK](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.14.0-8cc843a/bareun-dispatch-1.14.0.apk) · [A16 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.14.0-8cc843a/bareun-a16.zip) · [ERP 자동 설치 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.14.0-8cc843a/bareun-erp-install.zip) · [ERP 수동 교체 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.14.0-8cc843a/bareun-company-erp.zip)

관리자 전표 화면을 열면 날짜 검색 없이 한국 시간의 오늘 판매내역 전체를 자동으로 표시합니다. 오늘 20건이면 20건을 읽고, 1분마다·앱 복귀·오늘 날짜 변경 시 갱신합니다. 과거 날짜를 직접 선택하면 그 날짜를 유지합니다. 자동 조회는 JSON 내역이나 배송지를 반복 생성하지 않습니다.

전표를 누르면 원본 ID로 최신 수정본의 거래처·주소·연락처·전체 품목·수량·단가·금액·부가세·합계·공장도가·DC율·적요가 작성 화면에 채워집니다. 확인 후 앱 전표와 배송지로 한 번 등록하고 지역별 배차를 이어갑니다. `20261106-72`와 `26/11/06-72`를 같은 날짜·순번으로 검색합니다.

표시된 연결 주소는 실제 설정된 회사 ERP 주소입니다. 원본 저장소·PHP 1.13 이상을 확인하며 구형 PHP나 다른 저장소 결과를 정상 0건으로 표시하지 않습니다. 외부 E카운트 API를 호출하지 않습니다. 원본에 없는 금액·세율을 0원이나 10%로 추정하지 않으며 ERP 판매·확정·재고를 재처리하지 않습니다.

적용:

1. Node 서버와 앱을 함께 1.14로 갱신합니다. Render는 사용자가 `codex/free-node-test`의 `8cc843a`를 배포합니다.
2. 정상 연결된 ERP PHP 1.13 이상은 호환됩니다. 구형·누락 파일 또는 저장소 오류가 있다면 자동 설치 ZIP의 `bareun_update_1_14.php`를 기존 FTP `tire/erp`에 올립니다. ERP 관리자로 https://bobjjangs1231.dothome.co.kr/tire/erp/bareun_update_1_14.php 를 열어 **백업하고 ERP 파일 7개 적용**을 누릅니다. 설정·연동키·원본helper·DB·재고는 유지하며 성공하면 설치기가 삭제됩니다.
3. APK를 기존 앱 위에 설치합니다. A16 ZIP은 압축을 풀어 설치합니다. 기존 COMPANY_ERP_API_URL/COMPANY_ERP_TOKEN을 유지합니다. iOS는 보류 상태입니다.

검증:

- 서버 전체 회귀 테스트: 254
- 오늘20건 자동 조회·전체필드·등록·오류·한국 자정 모바일 검증: 7
- TypeScript 형식 검사: 통과
- 모바일 웹 export: 통과
- Android clean prebuild: 통과
- Android ARM64·ARM32 서명·같은 인증서·16KB 정렬: 통과
- A16 ARM64 APK·동일 최신 번들: 통과
- 내장 한국어 OCR·위치·오늘 자동 ERP 화면 검사: 통과
- 자동 설치기: 관리자·CSRF·고정 7개 해시·설정/키/helper 보존·자동 삭제·installed=1 이동·재실행·경로/심볼릭링크 거절·부분/전체 교체 복구·변조 거절·동시 잠금을 확인합니다.

검증에 사용한 합성 ERP 응답·가상 DB와 실제 회사 자료 조회를 구분합니다. 운영 FTP 적용·Render 배포·인증된 회사 전표·실물 휴대폰 카메라/GPS는 각 실행 여부를 별도로 확인합니다. 이 공개 APK/ZIP에 PIN·DB설정·연동키·고객 전표·제공된 비공개 ERP helper 원본은 포함하지 않습니다.

[사용·설치·검증 안내](https://github.com/bobjjangs-glitch/-system/blob/8cc843a/docs/ERP_1_14_AUTO_SALES.md)
