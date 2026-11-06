<?php
declare(strict_types=1);
require __DIR__ . '/inc/bootstrap.php';
require_login();
require_once __DIR__ . '/inc/dispatch_bridge.php';
require_once __DIR__ . '/inc/dispatch_sales.php';
if ((current_user()['role'] ?? '') !== 'admin') { http_response_code(403); exit('ERP 관리자만 연동을 설정할 수 있습니다.'); }
header('Cache-Control: no-store, private');
header('Referrer-Policy: no-referrer');
$path = __DIR__ . '/inc/dispatch_bridge.private.php'; $shown = ''; $error = '';
if (is_post()) {
    csrf_check();
    try {
        $previous = is_file($path) ? bd_load_config($path) : [];
        if (!is_array($previous)) throw new RuntimeException();
        $enabling = ($_POST['sales'] ?? '') === 'enable';
        if (!$enabling && ($_POST['issue'] ?? '') !== 'yes') throw new RuntimeException();
        if ($enabling && !is_file($path)) throw new RuntimeException();
        if ($enabling) bds_install(db());
        $token = $enabling ? '' : bin2hex(random_bytes(32));
        $instance = $previous['instance_id'] ?? bin2hex(random_bytes(16));
        if (!is_string($instance) || !preg_match('/^[a-f0-9]{32}$/D', $instance)) throw new RuntimeException();
        $config = $previous; $config['instance_id']=$instance; if (!$enabling) $config['token_hash']=hash('sha256',$token); if ($enabling) { $config['writer_user_id']=(int)current_user()['id']; $config['sequence_prefix']='SL'; }
        $tmp = tempnam(__DIR__ . '/inc', '.dispatch-');
        if ($tmp === false) throw new RuntimeException();
        chmod($tmp, 0600);
        if (file_put_contents($tmp, "<?php exit; ?>\n" . json_encode($config, JSON_THROW_ON_ERROR), LOCK_EX) === false || !rename($tmp, $path)) {
            @unlink($tmp); throw new RuntimeException();
        }
        $shown = $token;
    } catch (Throwable $e) { $error = !empty($enabling) ? '앱 판매 저장소를 준비하지 못했습니다. DB CREATE/ALTER 권한과 inc 폴더 쓰기 권한을 확인해 주세요.' : '연동키를 저장하지 못했습니다. inc 폴더의 PHP 쓰기 권한을 호스팅 관리자에서 확인해 주세요.'; }
}
$lookupReference = isset($_GET['lookup']) && is_string($_GET['lookup']) ? trim($_GET['lookup']) : '';
$lookupId=isset($_GET['documentId'])&&is_string($_GET['documentId'])?trim($_GET['documentId']):'';
$lookupResult=null;$lookupError='';$sourceInfo=null;$recent=[];
try {
    $pdo=db();$pdo->exec('START TRANSACTION READ ONLY');
    $currentConfig=is_file($path)?bd_load_config($path):[];$instance=$currentConfig['instance_id']??str_repeat('0',32);
    $sourceInfo=bd_read($pdo,'sales',['scope'=>'capabilities','date'=>bds_today(),'cursor'=>'0','limit'=>'1'],$instance);
    if(($sourceInfo['sourceSystem']??'')==='native-archive'){
        $q=$pdo->query("SELECT id,kind,source_doc,doc_date,current_version_id FROM `erp_ecount_documents` WHERE kind='sale' AND current_version_id IS NOT NULL ORDER BY doc_date DESC,id DESC LIMIT 8");
        foreach($q as $doc){$line=$pdo->prepare('SELECT row_json FROM `erp_ecount_doc_lines` WHERE version_id=? ORDER BY line_no LIMIT 1');$line->execute([$doc['current_version_id']]);$raw=$line->fetchColumn();$original=$raw===false?[]:[bd_native_raw((string)$raw,'전표번호')];$recent[]=['id'=>(string)$doc['id'],'reference'=>bd_native_identity($doc,$original),'date'=>$doc['doc_date']];}
    }else{
        foreach(bd_query($pdo,"SELECT id,trade_no,trade_date FROM erp_trades WHERE trade_type='sale' ORDER BY trade_date DESC,id DESC LIMIT 8") as $row)$recent[]=['id'=>(string)$row['id'],'reference'=>(string)$row['trade_no'],'date'=>(string)$row['trade_date']];
    }
    if($lookupReference!==''||$lookupId!==''){
        $query=['scope'=>'invoice','reference'=>$lookupReference,'date'=>bds_today(),'cursor'=>'0','limit'=>'2'];
        if($lookupId!==''){
            if(($sourceInfo['sourceSystem']??'')!=='native-archive')throw new InvalidArgumentException('이 저장소는 원본 ID 조회를 지원하지 않습니다. 아래 실제 전표번호를 선택해 주세요.');
            $query['documentId']=$lookupId;
        }
        $lookupResult=bd_read($pdo,'sales',$query,$instance);
        if(($lookupResult['scope']??'')!=='invoice'||($lookupResult['invoiceVersion']??0)!==2)throw new LogicException('BRIDGE_VERSION');
    }
    $pdo->commit();
}catch(Throwable $e){
    if(isset($pdo)&&$pdo->inTransaction())$pdo->rollBack();
    $lookupError=$e instanceof DispatchNativeReadError||$e instanceof InvalidArgumentException?$e->getMessage():($e instanceof LogicException&&$e->getMessage()==='BRIDGE_VERSION'?'연동 파일 버전이 맞지 않습니다. 최신 ZIP의 PHP 파일을 모두 함께 적용해 주세요.':'ERP 원본 자료를 읽지 못했습니다. 현재 조회 저장소와 설치 파일을 확인해 주세요.');
}

?>
<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>배차 앱 연결</title>
<style>body{font:16px/1.7 system-ui;background:#f2f6f4;color:#183e37;margin:0}main{max-width:660px;margin:28px auto;padding:24px;background:white;border-radius:20px}button{background:#24594b;color:white;border:0;border-radius:12px;padding:14px;font:inherit;width:100%}textarea{box-sizing:border-box;width:100%;padding:12px;font-size:16px}p{overflow-wrap:anywhere}a{color:#24594b}</style>
<main><h1>바른배차 · 회사 ERP 연결</h1><p>거래처·품목과 날짜별 판매전표·전표번호별 명세서를 배차 앱에서 조회합니다. 앱 판매 작성을 켜면 오늘 날짜의 작성중 판매전표를 ERP에 저장합니다. ERP 확정·재고 처리는 기존 ERP에서 진행합니다.</p>
<?php if ($error): ?><p role="alert"><?= h($error) ?></p><?php endif; ?>
<?php if ($shown): ?><p><strong>새 연결키가 발급되었습니다. 지금 한 번만 표시됩니다.</strong></p><textarea readonly rows="3" aria-label="새 연결키"><?= h($shown) ?></textarea><p>Render → Environment의 <code>COMPANY_ERP_TOKEN</code> 값으로 저장하세요. <code>COMPANY_ERP_API_URL</code>은 이 사이트의 <code>dispatch_api.php</code> HTTPS 주소입니다. 키를 채팅·앱·공개 저장소에 넣지 마세요.</p>
<?php else: ?><p><?= is_file($path) ? '연동키가 설정되어 있습니다. 재발급하면 기존 키는 사용할 수 없으므로 Render에서도 갱신해야 합니다.' : '아래 버튼으로 연결키를 발급한 뒤 Render 서버에 등록하세요.' ?></p><?php endif; ?>
<form method="post"><?= csrf_field() ?><input type="hidden" name="issue" value="yes"><button type="submit"><?= is_file($path) ? '연동키 다시 발급' : '연동키 발급' ?></button></form><?php if (is_file($path)): $activeConfig=bd_load_config($path); ?><h2>앱 판매 작성</h2><p><?= !empty($activeConfig['writer_user_id']) ? '앱 판매 작성이 설정되어 있습니다. 기존 연결키를 계속 사용합니다.' : '앱에서 판매전표와 배송지를 함께 저장하려면 아래 설정을 켜세요. 전표는 작성중 상태로 등록됩니다.' ?></p><form method="post"><?= csrf_field() ?><input type="hidden" name="sales" value="enable"><button type="submit">앱 판매 작성 허용 · 저장소 준비</button></form><?php endif; ?><h2>ERP 전표 조회 테스트 · 1.13.0</h2><p>로그인한 이 ERP와 같은 DB에서 전표번호를 직접 확인합니다. 재고·판매전표·연동키는 변경하지 않습니다.</p>
<?php if($sourceInfo): ?><p><strong>현재 조회 저장소 · <?=h((string)($sourceInfo['salesTable']??'erp_trades'))?></strong><br>판매전표 <?=number_format((int)($sourceInfo['totalSales']??0))?>건 · 연동 <?=h((string)($sourceInfo['bridgeVersion']??'이전 버전'))?></p><?php endif; ?>
<form method="get"><label>확인할 전표번호<input name="lookup" aria-label="확인할 전표번호" maxlength="100" value="<?= h($lookupReference) ?>" placeholder="아래 실제 전표번호를 선택해도 됩니다" style="box-sizing:border-box;width:100%;padding:12px;margin:10px 0;font-size:16px"></label>
<label>ERP 원본 ID · 선택<input name="documentId" aria-label="ERP 원본 ID" inputmode="numeric" maxlength="15" value="<?=h($lookupId)?>" placeholder="예: 판매 수정 주소의 id 값" style="box-sizing:border-box;width:100%;padding:12px;margin:10px 0;font-size:16px"></label><button type="submit">ERP 전표 조회 테스트</button></form>
<?php if($recent): ?><h3>이 저장소에 실제로 있는 최근 전표</h3><ul><?php foreach($recent as $r): ?><li><a href="?<?= ($sourceInfo['sourceSystem']??'')==='native-archive'?'documentId='.rawurlencode($r['id']):'lookup='.rawurlencode($r['reference']) ?>"><?=h($r['reference'])?></a> · <?=h($r['date'])?> · ID <?=h($r['id'])?></li><?php endforeach; ?></ul><?php endif; ?>
<?php if($lookupError): ?><p role="alert"><?= h($lookupError) ?></p><?php elseif($lookupResult): ?>
<?php if($lookupResult['total']===1): $found=$lookupResult['items'][0]; ?><p><strong>전표 조회 확인 완료 · <?= h($found['reference']) ?></strong><br>ERP 판매일자 <?= h($found['saleDate']??'미등록') ?> · 품목 <?= count($found['items']) ?>개 · 합계 <?= ($found['amount']===null?'미확인':number_format((float)$found['amount'])) ?>원</p><p>원본 ID <?=h((string)$found['id'])?><?=isset($found['sourceReference'])?' · 자료 번호 '.h($found['sourceReference']):''?></p><p><a href="<?=h($found['editUrl']??('trade_view.php?id='.(int)$found['id']))?>">기존 ERP 전표 화면에서 대조하기</a></p>
<?php elseif($lookupResult['total']===0): ?><p role="alert">현재 표시된 저장소에서 요청한 판매전표가 0건입니다. 위의 실제 최근 전표를 선택하거나 판매 수정 주소의 원본 ID로 대조해 주세요.</p><?php else: ?><p role="alert">날짜·순번이 같은 전표가 여러 건입니다. ERP 전표번호를 그대로 입력해 주세요.</p><?php endif; ?>
<?php endif; ?><p><a href="index.php">ERP로 돌아가기</a></p></main></html>
