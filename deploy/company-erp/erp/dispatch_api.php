<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
require __DIR__ . '/inc/dispatch_bridge.php';
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') { header('Allow: GET'); bd_fail(405, '조회 요청만 허용됩니다.'); }
try {
    $path = __DIR__ . '/inc/dispatch_bridge.private.php';
    if (!is_file($path)) bd_fail(503, 'ERP 관리자에게 배차 연동 설정을 요청해 주세요.');
    $config = bd_load_config($path);
    $token = $_SERVER['HTTP_X_DISPATCH_TOKEN'] ?? '';
    if (!is_array($config) || !is_string($token) || !bd_authorized($config, $token)) bd_fail(401, '연동 인증을 확인해 주세요.');
    require __DIR__ . '/inc/functions.php';
    $GLOBALS['CFG'] = require __DIR__ . '/inc/config.php';
    $kind = $_GET['kind'] ?? '';
    if (!is_string($kind)) bd_fail(400, '조회 항목을 확인해 주세요.');
    $pdo = db();
    // Each page and its change marker are read from one repeatable snapshot.
    $pdo->exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    $pdo->exec('START TRANSACTION READ ONLY');
    $result = bd_read($pdo, $kind, $_GET, $config['instance_id']);
    $pdo->commit();
    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
} catch (DomainException $e) { if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack(); bd_fail(409, $e->getMessage());
} catch (InvalidArgumentException $e) { if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack(); bd_fail(400, $e->getMessage());
} catch (LengthException $e) { if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack(); bd_fail(422, $e->getMessage());
} catch (Throwable $e) { if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack(); bd_fail(500, 'ERP 자료 조회에 실패했습니다. 설치된 ERP 구조와 연결 상태를 확인해 주세요.'); }
