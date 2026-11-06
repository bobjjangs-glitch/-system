<?php
declare(strict_types=1);
require __DIR__ . '/inc/bootstrap.php';
require_login();
require_once __DIR__ . '/inc/dispatch_bridge.php';
if ((current_user()['role'] ?? '') !== 'admin') { http_response_code(403); exit('ERP 관리자만 연동을 설정할 수 있습니다.'); }
header('Cache-Control: no-store, private');
header('Referrer-Policy: no-referrer');
$path = __DIR__ . '/inc/dispatch_bridge.private.php'; $shown = ''; $error = '';
if (is_post()) {
    csrf_check();
    try {
        $previous = is_file($path) ? bd_load_config($path) : [];
        if (!is_array($previous)) throw new RuntimeException();
        if (!isset($_POST['issue']) || $_POST['issue'] !== 'yes') throw new RuntimeException();
        $token = bin2hex(random_bytes(32));
        $instance = $previous['instance_id'] ?? bin2hex(random_bytes(16));
        if (!is_string($instance) || !preg_match('/^[a-f0-9]{32}$/D', $instance)) throw new RuntimeException();
        $config = ['token_hash' => hash('sha256', $token), 'instance_id' => $instance];
        $tmp = tempnam(__DIR__ . '/inc', '.dispatch-');
        if ($tmp === false) throw new RuntimeException();
        chmod($tmp, 0600);
        if (file_put_contents($tmp, "<?php exit; ?>\n" . json_encode($config, JSON_THROW_ON_ERROR), LOCK_EX) === false || !rename($tmp, $path)) {
            @unlink($tmp); throw new RuntimeException();
        }
        $shown = $token;
    } catch (Throwable $e) { $error = '연동키를 저장하지 못했습니다. inc 폴더의 PHP 쓰기 권한을 호스팅 관리자에서 확인해 주세요.'; }
}
?>
<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>배차 앱 연결</title>
<style>body{font:16px/1.7 system-ui;background:#f2f6f4;color:#183e37;margin:0}main{max-width:660px;margin:28px auto;padding:24px;background:white;border-radius:20px}button{background:#24594b;color:white;border:0;border-radius:12px;padding:14px;font:inherit;width:100%}textarea{box-sizing:border-box;width:100%;padding:12px;font-size:16px}p{overflow-wrap:anywhere}a{color:#24594b}</style>
<main><h1>바른배차 · 회사 ERP 연결</h1><p>거래처·품목과 날짜별 확정 판매전표를 배차 앱에서 조회합니다. ERP 전표·재고·금액을 변경하는 기능은 없습니다.</p>
<?php if ($error): ?><p role="alert"><?= h($error) ?></p><?php endif; ?>
<?php if ($shown): ?><p><strong>새 연결키가 발급되었습니다. 지금 한 번만 표시됩니다.</strong></p><textarea readonly rows="3" aria-label="새 연결키"><?= h($shown) ?></textarea><p>Render → Environment의 <code>COMPANY_ERP_TOKEN</code> 값으로 저장하세요. <code>COMPANY_ERP_API_URL</code>은 이 사이트의 <code>dispatch_api.php</code> HTTPS 주소입니다. 키를 채팅·앱·공개 저장소에 넣지 마세요.</p>
<?php else: ?><p><?= is_file($path) ? '연동키가 설정되어 있습니다. 재발급하면 기존 키는 사용할 수 없으므로 Render에서도 갱신해야 합니다.' : '아래 버튼으로 연결키를 발급한 뒤 Render 서버에 등록하세요.' ?></p><?php endif; ?>
<form method="post"><?= csrf_field() ?><input type="hidden" name="issue" value="yes"><button type="submit"><?= is_file($path) ? '연동키 다시 발급' : '연동키 발급' ?></button></form><p><a href="index.php">ERP로 돌아가기</a></p></main></html>
