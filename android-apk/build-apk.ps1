$ErrorActionPreference = "Stop"

$jdkDir = "C:\Program Files\Java\jdk1.8.0_281\bin"
$env:JAVA_HOME = "C:\Program Files\Java\jdk1.8.0_281"
$env:PATH = "$jdkDir;$env:PATH"

$sdkDir = "$env:LOCALAPPDATA\Android\Sdk"
$buildTools = "$sdkDir\build-tools\30.0.3"
$androidJar = "$sdkDir\platforms\android-34\android.jar"

$projectDir = "d:\workspaces\homecloud\android-apk"
$buildDir = "$projectDir\build"
$classesDir = "$buildDir\classes"

if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Force -Path $classesDir | Out-Null
New-Item -ItemType Directory -Force -Path "$projectDir\res" | Out-Null

Write-Output "1. Compiling Java sources..."
$javaFiles = Get-ChildItem -Path "$projectDir\src" -Recurse -Filter "*.java" | Select-Object -ExpandProperty FullName
& "$jdkDir\javac.exe" -encoding UTF-8 -source 1.8 -target 1.8 -bootclasspath $androidJar -classpath $androidJar -d $classesDir $javaFiles

Write-Output "2. Converting bytecode to DEX..."
& "$buildTools\dx.bat" --dex --output="$buildDir\classes.dex" $classesDir

Write-Output "3. Packaging unaligned APK with AAPT..."
& "$buildTools\aapt.exe" package -f -M "$projectDir\AndroidManifest.xml" -S "$projectDir\res" -I $androidJar -0 arsc -F "$buildDir\unaligned.apk"

Push-Location $buildDir
& "$buildTools\aapt.exe" add unaligned.apk classes.dex | Out-Null
Pop-Location

Write-Output "4. Aligning APK..."
& "$buildTools\zipalign.exe" -p -f 4 "$buildDir\unaligned.apk" "$buildDir\aligned.apk"

$keystore = "$projectDir\homecloud.keystore"
if (-not (Test-Path $keystore)) {
  Write-Output "5. Generating signing keystore..."
  & "$jdkDir\keytool.exe" -genkeypair -v -keystore $keystore -alias homecloud -keyalg RSA -keysize 2048 -validity 10000 -storepass homecloud123 -keypass homecloud123 -dname "CN=HomeCloud, OU=Sync, O=HomeCloud, L=Local, S=Local, C=US"
}

$finalApk = "d:\workspaces\homecloud\HomeCloud.apk"
Write-Output "6. Signing APK..."
& "$buildTools\apksigner.bat" sign --ks $keystore --ks-key-alias homecloud --ks-pass pass:homecloud123 --key-pass pass:homecloud123 --out $finalApk "$buildDir\aligned.apk"

Copy-Item -Force $finalApk "d:\workspaces\homecloud\desktop\src\mobile-web\HomeCloud.apk"
Write-Output "SUCCESS! Built signed APK at: $finalApk"
