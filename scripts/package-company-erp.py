#!/usr/bin/env python3
"""Package only the three new PHP bridge files, never existing ERP/private config."""
import hashlib
import pathlib
import sys
import zipfile
root=pathlib.Path(__file__).resolve().parents[1]
out=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '/workspace/artifacts/bareun-company-erp.zip')
files=['dispatch_api.php','dispatch_setup.php','inc/dispatch_bridge.php']
readme='''바른배차 · 회사 닷홈 ERP 연결

ZIP의 tire/erp 폴더 구조를 FTP의 기존 tire/erp에 추가하세요.
추가 파일: dispatch_api.php, dispatch_setup.php, inc/dispatch_bridge.php
기존 inc/config.php 또는 다른 ERP 소스/DB 파일은 포함하지 않습니다.

1. ERP 관리자 계정으로 다음 페이지에 로그인합니다.
https://bobjjangs1231.dothome.co.kr/tire/erp/dispatch_setup.php
2. 연동키 발급을 누릅니다. 키는 이 화면에서 지금 한 번만 표시됩니다.
3. Render → bareun-dispatch-test → Environment에 등록합니다.
COMPANY_ERP_API_URL=https://bobjjangs1231.dothome.co.kr/tire/erp/dispatch_api.php
COMPANY_ERP_TOKEN=발급된 연동키
실제 키를 채팅/앱/공개 저장소에 보내지 마세요.
4. 필요한 기존 무료 Render 내역을 백업하고 codex/free-node-test 최신 커밋을 수동 배포합니다.
5. 새 Android 앱 또는 갱신된 웹에서 전표 → 회사 ERP 실시간 가져오기를 사용합니다.

확정 판매전표만 조회합니다. 작성중/취소는 제외하고 수량이 0 이하인 항목이 있는
반품/혼합 전표는 전체 제외하여 안내합니다. ERP 주소/연락처가 비어 있으면 검토 중 입력합니다.
조회 결과를 검토하여 저장하기 전에는 배송지를 만들지 않습니다. 앱을 닫은 동안
자동 등록하지 않습니다. 버튼/검색을 실행할 때마다 ERP를 조회합니다.

요구 사항: 기존 ERP의 inc/bootstrap.php, inc/functions.php, inc/config.php와
공개 erp 저장소의 테이블 구조(erp_partners, erp_items, erp_trades, erp_trade_lines).
PHP 8.0 이상. PHP 8.3/MariaDB 10.11 가상 자료로 검증했습니다.
테스트는 실제 닷홈 설치 및 실제 회사 데이터 검증을 대신하지 않습니다.

연동키 저장 실패: inc 폴더를 PHP에서 쓸 수 있는지 호스팅 관리자에게 확인하세요.
키를 다시 발급하면 Render에도 새 키를 등록하고 재시작해야 합니다.
연동키 파일 inc/dispatch_bridge.private.php는 공개 저장소에 올리지 마세요.
'''
out.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(out,'x',compression=zipfile.ZIP_DEFLATED) as z:
 for name in files:
  path=root/'deploy/company-erp/erp'/name
  assert path.is_file() and not path.is_symlink()
  z.write(path,'tire/erp/'+name)
 z.writestr('설치안내.txt',readme)
with zipfile.ZipFile(out) as z:
 assert z.testzip() is None
 assert len(z.namelist())==4
 assert not any('private.php' in x or x.endswith('/config.php') for x in z.namelist())
digest=hashlib.sha256(out.read_bytes()).hexdigest()
out.with_suffix(out.suffix+'.sha256').write_text(digest+'  '+out.name+'\n')
print(f'Created {out} ({out.stat().st_size:,} bytes; 3 PHP files and installation guide)')
