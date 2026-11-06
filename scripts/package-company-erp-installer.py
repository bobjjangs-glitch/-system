from pathlib import Path
import re, subprocess, sys
import hashlib,json,zipfile
root=Path(__file__).resolve().parents[1];out=Path(sys.argv[1]) if len(sys.argv)>1 else Path('/workspace/artifacts');out.mkdir(parents=True,exist_ok=True)
rev=subprocess.check_output(['git','rev-parse','--short','HEAD'],cwd=root,text=True).strip();version=json.loads((root/'app.json').read_text())['expo']['version']
assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',version) and re.fullmatch(r'[a-f0-9]+',rev)
installer_name='bareun_update_'+version.rsplit('.',1)[0].replace('.','_')+'.php'
files=['dispatch_api.php','dispatch_setup.php','dispatch_sale.php','inc/dispatch_bridge.php','inc/dispatch_sales.php','inc/dispatch_native.php','inc/dispatch_catalog_native.php']
import base64
entries=[]
for name in files:
 data=(root/'deploy/company-erp/erp'/name).read_bytes();entries.append("        "+repr(name)+" => ['sha'=>'"+hashlib.sha256(data).hexdigest()+"','body'=>'"+base64.b64encode(data).decode()+"']")
payload=',\n'.join(entries)
php='''<?php
declare(strict_types=1);
/** Fixed Bareun ERP update. Admin session + CSRF required. No command execution or arbitrary upload. */
function bu_payload(): array { return [
__PAYLOAD__
    ]; }
function bu_root(): string {
    $root=realpath(__DIR__);if($root===false||!is_file($root.'/inc/bootstrap.php')||is_link($root.'/inc'))throw new RuntimeException('기존 ERP index.php와 inc 폴더가 있는 tire/erp 폴더에 설치 파일을 올려 주세요.');return $root;
}
function bu_bytes(array $entry): string {
    $data=base64_decode($entry['body'],true);if($data===false||!hash_equals($entry['sha'],hash('sha256',$data)))throw new RuntimeException('설치 파일의 무결성을 확인하지 못했습니다. 파일을 다시 받아 주세요.');return $data;
}
function bu_apply(string $root): array {
    $payload=bu_payload();$old=[];$staged=[];$changed=[];$allCurrent=true;$backup='';$lock=null;
    try {
        foreach($payload as $name=>$entry){
            $target=$root.'/'.$name;
            if(is_link($target)||is_link(dirname($target))||!is_dir(dirname($target))||!is_writable(dirname($target))||is_dir($target))throw new RuntimeException('ERP 폴더의 파일 형식 또는 쓰기 권한을 확인해 주세요: '.$name);
            bu_bytes($entry);
            $exists=is_file($target);$bytes=$exists?@file_get_contents($target):null;
            if($exists&&!is_string($bytes))throw new RuntimeException('기존 파일을 백업할 수 없습니다: '.$name);
            $old[$name]=['exists'=>$exists,'body'=>$exists?base64_encode($bytes):null,'sha'=>$exists?hash('sha256',$bytes):null,'mode'=>$exists?(fileperms($target)&0777):0644];
            if(!$exists||!hash_equals($entry['sha'],hash('sha256',$bytes)))$allCurrent=false;
        }
        if($allCurrent)return ['current'=>true,'backup'=>null];
        $lockPath=$root.'/inc/.dispatch-update.lock.php';if(is_link($lockPath))throw new RuntimeException('설치 잠금 파일을 확인해 주세요.');
        $lock=@fopen($lockPath,'c+');if($lock===false||!flock($lock,LOCK_EX|LOCK_NB))throw new RuntimeException('다른 갱신 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
        if(fstat($lock)['size']===0){fwrite($lock,"<?php exit; ?>\\n");fflush($lock);}@chmod($lockPath,0600);
        // Re-read under lock so overlapping installers never restore stale bytes.
        foreach($payload as $name=>$entry){$target=$root.'/'.$name;if(is_link($target)||is_dir($target))throw new RuntimeException('대상 파일을 확인해 주세요.');$exists=is_file($target);$bytes=$exists?@file_get_contents($target):null;if($exists&&!is_string($bytes))throw new RuntimeException('기존 파일 백업에 실패했습니다.');$old[$name]=['exists'=>$exists,'body'=>$exists?base64_encode($bytes):null,'sha'=>$exists?hash('sha256',$bytes):null,'mode'=>$exists?(fileperms($target)&0777):0644];}
        $backup=$root.'/inc/.dispatch-backup-'.date('Ymd_His').'-'.bin2hex(random_bytes(4)).'.php';
        if(@file_put_contents($backup,"<?php exit; ?>\\n".json_encode(['version'=>'1.11.0','source'=>'2afd904','files'=>$old],JSON_THROW_ON_ERROR),LOCK_EX)===false)throw new RuntimeException('기존 파일 백업을 만들지 못했습니다.');@chmod($backup,0600);
        foreach($payload as $name=>$entry){$tmp=@tempnam(dirname($root.'/'.$name),'.dispatch-stage-');if($tmp===false)throw new RuntimeException('파일 준비에 실패했습니다.');$staged[$name]=$tmp;$bytes=bu_bytes($entry);if(@file_put_contents($tmp,$bytes,LOCK_EX)!==strlen($bytes))throw new RuntimeException('파일 준비에 실패했습니다.');@chmod($tmp,$old[$name]['mode']?:0644);if(!hash_equals($entry['sha'],hash_file('sha256',$tmp)))throw new RuntimeException('준비 파일 검증에 실패했습니다.');}
        foreach($payload as $name=>$entry){if(!@rename($staged[$name],$root.'/'.$name))throw new RuntimeException('파일 적용에 실패했습니다: '.$name);$changed[]=$name;}
        foreach($payload as $name=>$entry)if(!hash_equals($entry['sha'],hash_file('sha256',$root.'/'.$name)))throw new RuntimeException('적용 결과 검증에 실패했습니다.');
        return ['current'=>false,'backup'=>basename($backup)];
    } catch(Throwable $e){
        $restored=true;
        foreach(array_reverse($changed) as $name){$target=$root.'/'.$name;$item=$old[$name];if(!$item['exists']){if(is_file($target)&&!@unlink($target))$restored=false;continue;}$tmp=@tempnam(dirname($target),'.dispatch-restore-');$bytes=base64_decode($item['body'],true);if($tmp===false||$bytes===false||@file_put_contents($tmp,$bytes,LOCK_EX)!==strlen($bytes)){if($tmp)@unlink($tmp);$restored=false;continue;}@chmod($tmp,$item['mode']?:0644);if(!@rename($tmp,$target)||!hash_equals($item['sha'],hash_file('sha256',$target)))$restored=false;}
        throw new RuntimeException($changed?($restored?'적용에 실패해 변경된 파일을 기존 상태로 자동 복구했습니다.':'일부 파일의 자동 복구를 완료하지 못했습니다. 보호된 백업을 보존하고 관리자에게 확인하세요.'): $e->getMessage());
    } finally {foreach($staged as $tmp)if(is_file($tmp))@unlink($tmp);if(is_resource($lock)){flock($lock,LOCK_UN);fclose($lock);}}
}
if(PHP_SAPI==='cli')return;
try{$root=bu_root();}catch(Throwable $e){http_response_code(400);header('Content-Type:text/plain;charset=utf-8');exit($e->getMessage());}
require $root.'/inc/bootstrap.php';
require_login();
if((current_user()['role']??'')!=='admin'){http_response_code(403);exit('ERP 관리자만 파일을 적용할 수 있습니다.');}
header('Cache-Control: no-store, private');header('Referrer-Policy: no-referrer');$error='';
if(is_post()){
    csrf_check();
    try{
        if(($_POST['action']??'')!=='install')throw new RuntimeException('설치 작업을 확인해 주세요.');
        $result=bu_apply($root);
        // A one-time installer removes itself after a successful, verified update.
        @unlink(__FILE__);
        header('Location: dispatch_setup.php?installed=1',true,303);exit;
    }catch(Throwable $e){$error=$e->getMessage();}
}
?>
<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>바른배차 ERP 자동 적용</title>
<style>body{font:16px/1.6 system-ui;margin:0;padding:18px;background:#f1f5f3;color:#183e37}main{max-width:650px;margin:10px auto;background:white;padding:22px;border-radius:18px}button{width:100%;padding:16px;border:0;border-radius:12px;background:#24594b;color:white;font:inherit;font-weight:700}li{overflow-wrap:anywhere}p{overflow-wrap:anywhere}</style>
<main><h1>바른배차 ERP 1.11.0 자동 적용</h1><p>검증한 PHP 7개를 백업한 뒤 교체합니다. 출처 커밋: <code>2afd904</code></p><ul><?php foreach(array_keys(bu_payload()) as $name): ?><li><?= h($name) ?></li><?php endforeach; ?></ul>
<p>ERP DB·연동키·판매전표·재고는 유지됩니다. 기존 파일 백업은 inc 폴더의 PHP 실행 차단 형식으로 보관하며, 적용 실패 시 교체한 파일을 자동 복구합니다. 성공하면 이 설치 파일은 스스로 삭제되고 실제 최근 전표 목록과 조회 저장소를 보여주는 확인 화면으로 이동합니다.</p>
<?php if($error): ?><p role="alert" style="color:#b3453d"><?= h($error) ?></p><?php endif; ?>
<form method="post"><?= csrf_field() ?><input type="hidden" name="action" value="install"><button type="submit">백업하고 ERP 파일 7개 적용</button></form><p><a href="index.php">ERP로 돌아가기</a></p></main></html>
'''.replace('__PAYLOAD__',payload).replace('1.11.0',version).replace('2afd904',rev)
phpFile=out/installer_name;phpFile.write_text(php)
package=out/f'bareun-erp-install-{version}-{rev}.zip'
guide='''바른배차 ERP 자동 적용 · 1.11.0

1. bareun_update_1_11.php 하나를 기존 FTP의 tire/erp 폴더에 올립니다.
   원래 index.php와 inc 폴더가 있는 위치입니다.
2. ERP 관리자 계정으로 로그인하고 다음 주소를 엽니다.
   https://bobjjangs1231.dothome.co.kr/tire/erp/bareun_update_1_11.php
3. ‘백업하고 ERP 파일 7개 적용’을 누릅니다.
   7개 파일을 자동 백업/교체하고 설치 파일은 성공 후 삭제됩니다.
   ERP DB·연동키·판매전표·재고를 수정하지 않습니다.
4. 자동으로 열리는 최근 전표 중 실제 번호 또는 원본 ID를 선택해 ERP 원본과 대조합니다.

인증: 기존 ERP 관리자 로그인과 CSRF 검증이 필요합니다. 일반 사무 계정은 불가합니다.
파일 대상은 고정된 7개이며 DB 설정/연동키 파일은 대상에 없습니다.
외부 파일 다운로드나 비밀번호 입력 없이 설치 파일에 내장된 검증본만 적용합니다.
부족한 폴더 쓰기 권한/잘못된 경로는 변경 전에 안내합니다.
Render 배포는 사용자가 진행하기로 했습니다. codex/free-node-test 커밋 2afd904를 배포하세요.
실제 운영 파일 적용은 아직 실행되지 않았습니다.
'''
guide=guide.replace('bareun_update_1_11.php',installer_name).replace('1.11.0',version).replace('2afd904',rev)
with zipfile.ZipFile(package,'w',compression=zipfile.ZIP_DEFLATED)as z:z.write(phpFile,phpFile.name);z.writestr('설치안내.txt',guide)
with zipfile.ZipFile(package)as z:assert z.testzip() is None and len(z.namelist())==2
print('Installer PHP',len(php.encode()),hashlib.sha256(php.encode()).hexdigest());print('Installer ZIP',package.stat().st_size,hashlib.sha256(package.read_bytes()).hexdigest())
