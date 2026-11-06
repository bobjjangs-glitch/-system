<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');header('Cache-Control: no-store, private');header('X-Content-Type-Options: nosniff');header('X-Robots-Tag: noindex,nofollow');
require __DIR__.'/inc/dispatch_bridge.php';require __DIR__.'/inc/dispatch_sales.php';
try {
    $path=__DIR__.'/inc/dispatch_bridge.private.php';if(!is_file($path))bd_fail(503,'ERP 연동 설정이 필요합니다.');$config=bd_load_config($path);
    if(!bd_authorized($config,$_SERVER['HTTP_X_DISPATCH_TOKEN']??''))bd_fail(401,'ERP 연결키를 확인해 주세요.');
    require __DIR__.'/inc/functions.php';$GLOBALS['CFG']=require __DIR__.'/inc/config.php';$pdo=db();
    $method=$_SERVER['REQUEST_METHOD']??'';
    if($method==='GET')$result=bds_context($pdo,$config);
    elseif($method==='POST'){$body=file_get_contents('php://input',false,null,0,1048577);if(strlen($body)>1048576)throw new InvalidArgumentException();try{$input=json_decode($body,true,64,JSON_THROW_ON_ERROR);}catch(JsonException $e){throw new InvalidArgumentException();}if(!is_array($input))throw new InvalidArgumentException();for($attempt=0;;$attempt++){try{$result=bds_create($pdo,$config,$input);break;}catch(PDOException $e){$driver=(int)($e->errorInfo[1]??0);if($attempt>=3||!in_array($driver,[1213,1205,1062],true))throw $e;usleep(random_int(10000,50000)*($attempt+1));}}}
    else{header('Allow: GET, POST');bd_fail(405,'지원하지 않는 요청입니다.');}
    echo json_encode($result,JSON_UNESCAPED_UNICODE|JSON_INVALID_UTF8_SUBSTITUTE|JSON_THROW_ON_ERROR);
}catch(Throwable $e){$code=$e instanceof InvalidArgumentException?'INPUT':($e instanceof LogicException&&$e->getMessage()==='WRITE_DISABLED'?'WRITE_DISABLED':($e instanceof DomainException?'REQUEST_CONFLICT':'SAVE_FAILED'));http_response_code(in_array($code,['INPUT','WRITE_DISABLED'],true)?422:($code==='REQUEST_CONFLICT'?409:500));echo json_encode(['ok'=>false,'code'=>$code,'safeToEdit'=>in_array($code,['INPUT','WRITE_DISABLED'],true),'error'=>'ERP 판매 저장을 완료하지 못했습니다. 같은 전표에서 다시 확인해 주세요.'],JSON_UNESCAPED_UNICODE);}
