#!/bin/bash
set -x
OUT=results
adb install -r android/app/build/outputs/apk/debug/app-debug.apk > $OUT/install.txt 2>&1
adb logcat -c
adb shell am start -n ma.sonicod.operations/.MainActivity
sleep 12
PID=$(adb shell pidof ma.sonicod.operations | tr -d '\r')
echo "PID=$PID" > $OUT/pid.txt
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://127.0.0.1:9222/json/list > $OUT/targets.json
(cd tests && OUT=../$OUT timeout 600 node app_test.js) > $OUT/node.txt 2>&1
(cd tests && OUT=../$OUT timeout 600 node bot_test.js) >> $OUT/node.txt 2>&1
(cd tests && OUT=../$OUT timeout 300 node scan_test.js) >> $OUT/node.txt 2>&1
adb exec-out screencap -p > $OUT/99_ecran_final.png
adb logcat -d > $OUT/logcat_full.txt
grep -E "FATAL|AndroidRuntime|sonicod|chromium" $OUT/logcat_full.txt | tail -200 > $OUT/logcat_app.txt
exit 0
