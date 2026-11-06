# 회사 ERP 연결

현재 버전 1.13.0(23)의 설치·실제 원본 판매전표 조회·최신 수정본 확인·배차 절차는 [자체 ERP 원본 연결 안내](ERP_1_13_NATIVE.md)를 따릅니다.

회사 ERP는 https://bobjjangs1231.dothome.co.kr/tire/erp/index.php 입니다. 실제 판매 수정 화면인 `native_trade_edit.php`가 읽는 회사 DB의 원본 보관 자료를 연결합니다. 이 저장소의 `erp_ecount_*` 이름은 외부 E카운트 API 연결을 뜻하지 않습니다.

기존 전표 조회·앱 배송 등록은 ERP 판매·확정·재고를 변경하지 않습니다. 앱의 새 수기 판매는 별도 일반 판매 저장소에 작성중으로 생성하며 원본 보관 전표와 구분합니다. 비밀 연결키는 Render 서버의 `COMPANY_ERP_TOKEN`에만 저장하며 기존 키를 유지합니다.
