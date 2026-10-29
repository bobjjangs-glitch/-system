#!/usr/bin/env python3
"""Install the pinned, verified Android build tools in this managed workspace."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import urllib.parse
import urllib.request
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--with-emulator', action='store_true')
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path(os.environ.get('BAREUN_CLOUD_TOOLS_ROOT', '/workspace/.expo-development'))
manifest = json.loads((repo / 'deploy/android/toolchain.json').read_text())
downloads = root / 'android-downloads'
downloads.mkdir(parents=True, exist_ok=True)

def checksum(path, algorithm):
    digest = hashlib.new(algorithm)
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def download(url, name, algorithm, expected, size=None):
    target = downloads / name
    if target.exists() and checksum(target, algorithm) == expected and (size is None or target.stat().st_size == int(size)):
        return target
    temporary = target.with_suffix(target.suffix + '.part')
    with urllib.request.urlopen(url, timeout=180) as response, temporary.open('wb') as stream:
        shutil.copyfileobj(response, stream, 1024 * 1024)
    if checksum(temporary, algorithm) != expected or size is not None and temporary.stat().st_size != int(size):
        temporary.unlink()
        raise RuntimeError('Artifact verification failed: ' + name)
    temporary.replace(target)
    return target

for jdk in manifest['jdks']:
    target = root / f"jdk-{jdk['major']}"
    archive = download(jdk['archive_url'], f"jdk{jdk['major']}.tar.gz", 'sha256', jdk['sha256'])
    if not target.exists():
        stage = root / f"jdk-{jdk['major']}-unpack"
        stage.mkdir(exist_ok=False)
        with tarfile.open(archive) as compressed:
            compressed.extractall(stage, filter='data')
        members = list(stage.iterdir())
        if len(members) != 1 or not (members[0] / 'bin/javac').is_file():
            raise RuntimeError('Unexpected JDK archive layout')
        members[0].rename(target)
        stage.rmdir()

sdk = root / 'android-sdk'
tools = manifest['sdk_tools']
archive = download(tools['url'], 'cmdline-tools.zip', tools['checksum_type'], tools['checksum'], tools['size'])
if not (sdk / 'cmdline-tools/latest/bin/sdkmanager').is_file():
    stage = root / 'sdk-tools-unpack'
    stage.mkdir(exist_ok=False)
    with zipfile.ZipFile(archive) as compressed:
        for member in compressed.infolist():
            if member.filename.startswith('/') or '..' in pathlib.PurePosixPath(member.filename).parts:
                raise RuntimeError('Unsafe SDK archive path')
        compressed.extractall(stage)
    (sdk / 'cmdline-tools').mkdir(parents=True, exist_ok=True)
    (stage / 'cmdline-tools').rename(sdk / 'cmdline-tools/latest')
    stage.rmdir()
    for binary in (sdk / 'cmdline-tools/latest/bin').iterdir():
        binary.chmod(binary.stat().st_mode | 0o111)

gradle_home = root / 'gradle-cache'
gradle_home.mkdir(exist_ok=True)
properties = gradle_home / 'gradle.properties'
original = properties.read_text() if properties.exists() else ''
existing = dict(re.findall(r'^([^#!\s][^=]*)=(.*)$', original, re.M))
required = {
    'org.gradle.workers.max': '2',
    'org.gradle.parallel': 'false',
    'org.gradle.java.installations.paths': f'{root}/jdk-17,{root}/jdk-21',
    'org.gradle.java.installations.auto-download': 'false',
}
policy_file = pathlib.Path('/etc/codex/network-policy.json')
if policy_file.exists():
    proxy = urllib.parse.urlsplit(json.loads(policy_file.read_text()).get('http_proxy', ''))
    if proxy.hostname:
        for protocol in ['http', 'https']:
            required[f'systemProp.{protocol}.proxyHost'] = proxy.hostname
            required[f'systemProp.{protocol}.proxyPort'] = str(proxy.port or 8080)
        required['systemProp.http.nonProxyHosts'] = 'localhost|127.*|[::1]'
        trust = pathlib.Path('/etc/ssl/certs/java/cacerts')
        if not trust.is_file():
            raise RuntimeError('The managed Java CA trust store is missing')
        required['systemProp.javax.net.ssl.trustStore'] = str(trust)
for key, value in required.items():
    if key in existing and existing[key] != value:
        raise RuntimeError(f'Preserve and review the conflicting Gradle setting: {key}')
missing = {key: value for key, value in required.items() if key not in existing}
if missing:
    properties.write_text(original.rstrip() + '\n' + ''.join(f'{key}={value}\n' for key, value in missing.items()))

wrapper = repo / 'android/gradle/wrapper/gradle-wrapper.properties'
if wrapper.exists():
    text = wrapper.read_text()
    distribution = re.search(r'distributionUrl=.*?/(gradle-[0-9.]+-bin\.zip)', text)
    if not distribution:
        raise RuntimeError('Review the custom Gradle distribution before using this installer')
    with urllib.request.urlopen('https://services.gradle.org/distributions/' + distribution[1] + '.sha256', timeout=40) as response:
        expected = response.read().decode().strip()
    if not re.fullmatch('[0-9a-fA-F]{64}', expected):
        raise RuntimeError('Official Gradle checksum was not found')
    configured = re.search(r'^distributionSha256Sum=(.+)$', text, re.M)
    if configured and configured[1].lower() != expected.lower():
        raise RuntimeError('Existing Gradle checksum conflicts with the official release')
    if not configured:
        wrapper.write_text(text.rstrip() + '\ndistributionSha256Sum=' + expected + '\n')

packages = manifest['packages'] + (manifest['emulator_packages'] if args.with_emulator else [])
missing_packages = [package for package in packages if not (sdk.joinpath(*package.split(';')) / 'source.properties').is_file()]
if missing_packages:
    env = os.environ.copy()
    env.update(JAVA_HOME=str(root / 'jdk-21'), ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk), ANDROID_USER_HOME=str(root / 'android-user'), ANDROID_AVD_HOME=str(root / 'android-user/avd'))
    env['PATH'] = str(root / 'jdk-21/bin') + os.pathsep + env['PATH']
    if 'javax.net.ssl.trustStore=' not in env.get('JAVA_OPTS', '') and pathlib.Path('/etc/ssl/certs/java/cacerts').is_file():
        env['JAVA_OPTS'] = env.get('JAVA_OPTS', '') + ' -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts'
    subprocess.run([str(sdk / 'cmdline-tools/latest/bin/sdkmanager'), '--sdk_root=' + str(sdk), *missing_packages], env=env, check=True)
print('Verified JDK 17/21, Android SDK packages, Gradle trust and build-worker settings.')
