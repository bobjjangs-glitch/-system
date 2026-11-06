# 바른배차 1.12.0(22) Android 내부 테스트

Source: `codex/free-node-test`, `dfe59ba`.

[휴대폰 APK](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.12.0-dfe59ba/bareun-dispatch-1.12.0.apk) · [Galaxy A16 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.12.0-dfe59ba/bareun-a16.zip) · [ERP 자동 설치 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.12.0-dfe59ba/bareun-erp-install.zip) · [ERP 수동 교체 ZIP](https://github.com/bobjjangs-glitch/-system/raw/refs/heads/codex/apk-1.12.0-dfe59ba/bareun-company-erp.zip)

## 사용

전표 화면에서 거래처·품목을 자동으로 불러옵니다. 판매 조회 일자 → 일자 조회 → 전표번호 선택 → ERP 판매 수정 화면의 최신 전체 내용 확인 → **확인하고 전표 등록** → 지역별 배차 추천 순서입니다. 공급자·거래처·배송정보·결제수단/계좌·고객/차량 원본 정보·품목·수량·단가·금액·합계·공장도가·DC율·적요를 보존합니다. 확인 중 ERP가 바뀌면 최신 내용을 다시 확인하도록 하며 중복 전표와 재고 변경을 막습니다.

E카운트 API·메뉴·환경변수 설정은 제거했습니다. 과거 엑셀/전표 자료는 유지합니다. 날짜별 목록을 전체 페이지로 읽고 SL 접두사/순번 0/날짜 0 표기 차이를 처리합니다. 사진 OCR의 금액 열을 읽어 검산하고 자동 채우기·보관 중에도 금액을 보존합니다. 인쇄값에 임의로 부가세를 더하거나 수동 입력을 덮어쓰지 않습니다. 사진 상태에 따른 인식 정확도와 5초 완료를 모든 단말에서 보장하는 것은 아닙니다.

관리자는 앱의 판매조회 JSON·전표·배송지·코스·기사 계정을 삭제할 수 있습니다. 삭제 범위는 확인창에 표시하며 운행/완료 상태를 이유로 관리자 삭제를 차단하지 않습니다. 연결된 앱 코스/위치/세션 참조를 정리합니다. 회사 ERP 원본 판매/재고를 삭제하는 기능은 아닙니다.

## 적용 순서

1. ERP 자동 설치 ZIP을 풀어 `bareun_update_1_12.php` 하나를 FTP의 기존 `tire/erp`에 올립니다. 기존 index.php와 inc 폴더가 있는 위치입니다.
2. ERP 관리자로 로그인한 뒤 https://bobjjangs1231.dothome.co.kr/tire/erp/bareun_update_1_12.php 에서 **백업하고 ERP 파일 5개 적용**을 누릅니다. 고정된 파일만 검증·백업·교체하고 실패 시 자동 복구합니다. 성공하면 설치 파일은 삭제됩니다. DB 설정·연동키·판매·재고를 변경하지 않습니다.
3. Render 배포는 사용자가 직접 진행하기로 했습니다. 필요한 기존 내역을 보관한 후 **codex/free-node-test의 dfe59ba**를 수동 배포하세요. 기존 COMPANY_ERP_API_URL과 COMPANY_ERP_TOKEN을 사용합니다. 키는 채팅/앱/공개 저장소에 넣지 않습니다.
4. APK를 휴대폰 Chrome에서 다운로드해 기존 앱 위에 설치합니다. A16 ZIP은 압축을 풀어 APK를 설치합니다. Android 7 이상, 일반 APK는 ARM64/ARM32, A16 ZIP은 ARM64 전용입니다. iOS는 보류 상태입니다.

## 확인 범위

APK 제작 전에 서버 211/211, 실제 PHP 8.3.36·MariaDB 10.11·모바일 브라우저 15/15와 접두사 없는 ERP 구조 1개를 검증했습니다. ERP 자료는 가상 데이터입니다. 65건 전체 날짜 조회·최신 전체 내용·한 번 확인 등록·변경/중복 거절·실제 지역별 코스 추천·JSON 삭제·이전 서버 차단·과거 명세서 보존을 포함합니다. 자동 설치기는 별도로 관리자/CSRF·무결성·설정/키 보존·성공 후 삭제·재실행·경로 거절·실패 복구 6개를 통과했습니다.

제공된 PDF 내장 텍스트/좌표에서 수량 2·단가 368,000·합계 736,000·공장도가 451,000·총합계 736,000이 일치했습니다. 업로드·재열기·320px 모바일 검토 화면에서도 같은 단가/합계를 표시하고 모르는 공급가액/부가세를 0원으로 바꾸지 않음을 확인했습니다. 실제 휴대폰 카메라 OCR 시험과 구별합니다. 실제 회사 전표 48/49의 인증된 조회, 운영 FTP 적용, Render 배포, 실물 단말/GPS 확인은 이 작업 환경에서 수행하지 않았습니다. 사용자 PC의 FTP 창을 클라우드에서 조작할 수 없어 파일 하나 업로드는 사용자 작업이 필요합니다.

[설치·사용·검증 상세](https://github.com/bobjjangs-glitch/-system/blob/dfe59ba/docs/ERP_1_12_WORKFLOW.md)

Public APK/ERP package downloads are authorized by the repository owner. No customer receipt, PIN, database config or server secret is included.
